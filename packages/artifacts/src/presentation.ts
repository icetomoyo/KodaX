import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { XMLParser } from 'fast-xml-parser';
import path from 'node:path';
import type { ArtifactObject, Box, Diagnostic, EditInput, PresentationInput } from './types.js';
import { artifactPath, checkZipLimits } from './files.js';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false });
type Xml = Record<string, unknown>;
const record = (value: unknown): Xml => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Xml : {};
const array = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function checkBox(box: Box): void {
 for (const value of [box.x, box.y, box.width, box.height]) if (!Number.isFinite(value) || Math.abs(value) > 100) throw new Error('Invalid presentation geometry.');
 if (box.width <= 0 || box.height <= 0) throw new Error('Presentation size must be positive.');
}
export async function createPresentation(input: PresentationInput, root: string): Promise<Buffer> {
 if (!Array.isArray(input.slides) || !input.slides.length || input.slides.length > 200) throw new Error('Presentation requires 1–200 slides.');
 // PptxGenJS 的 CJS 声明在 NodeNext 下多一层 default，运行值本身仍是构造器。
 const Writer = PptxGenJS as unknown as typeof PptxGenJS.default;
 const deck = new Writer(); deck.layout = 'LAYOUT_WIDE';
 for (const page of input.slides as PresentationInput['slides']) {
   if (!Array.isArray(page.elements) || page.elements.length > 200) throw new Error('Too many slide elements.');
   const slide = deck.addSlide();
   for (const element of page.elements) {
     checkBox(element);
     const box = { x: element.x, y: element.y, w: element.width, h: element.height };
     switch (element.type) {
      case 'text':
       if (typeof element.text !== 'string' || element.text.length > 20_000) throw new Error('Invalid presentation text.');
       if (element.fontSize !== undefined && (!Number.isFinite(element.fontSize) || element.fontSize <= 0 || element.fontSize > 400)) throw new Error('Invalid font size.');
       if (element.color !== undefined && !/^[a-f0-9]{6}$/i.test(element.color)) throw new Error('Invalid text color.');
       if (element.fontFace !== undefined && (typeof element.fontFace !== 'string' || element.fontFace.length > 200)) throw new Error('Invalid font face.');
       slide.addText(element.text, { ...box, fontSize: element.fontSize ?? 28, fontFace: element.fontFace ?? 'Arial', color: element.color ?? '172C45', margin: 0 }); break;
      case 'rectangle':
       if (!/^[a-f0-9]{6}$/i.test(element.color)) throw new Error('Invalid rectangle color.');
       slide.addShape(deck.ShapeType.rect, { ...box, fill: { color: element.color }, line: { color: element.color } }); break;
      case 'image': slide.addImage({ ...box, path: await artifactPath(root, element.path) }); break;
      case 'table':
       if (!element.rows.length || element.rows.length > 200 || element.rows.some((row: readonly string[]) => row.length > 50 || row.some((cell: string) => typeof cell !== 'string'))) throw new Error('Invalid table.');
       slide.addTable(element.rows.map((row: readonly string[]) => [...row]), { ...box, fontSize: 18 }); break;
      case 'chart':
       if (!element.categories.length || element.categories.length > 200 || element.categories.length !== element.values.length || element.categories.some((value: string) => typeof value !== 'string') || element.values.some((value: number) => !Number.isFinite(value))) throw new Error('Invalid chart data.');
       slide.addChart(deck.ChartType.bar, [{ name: element.name ?? 'Series', labels: [...element.categories], values: [...element.values] }], box); break;
      default: throw new Error('Unsupported creation element.');
     }
   }
 }
 const data = await deck.write({ outputType: 'nodebuffer' });
 if (!Buffer.isBuffer(data)) throw new Error('PPTX writer did not return bytes.');
 // Writer tables can reuse shape IDs; normalize our own slides before exposing stable IDs.
 const zip = await JSZip.loadAsync(data);
 for (const name of Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
  let id = 0;
  const source = await zip.file(name)!.async('string');
  zip.file(name, source.replace(/<p:cNvPr\b[^>]*>/g, tag => tag.replace(/\bid="[^"]+"/, 'id="' + (++id) + '"')));
 }
 return zip.generateAsync({ type: 'nodebuffer' });
}
export async function inspectPresentation(bytes: Buffer) {
 checkZipLimits(bytes);
 const zip = await JSZip.loadAsync(bytes);
 const xml = async (part: string): Promise<string> => {
   const file = zip.file(part); if (!file) throw new Error('Missing PPTX part: ' + part);
   return file.async('string');
 };
 const presentation = record(record(parser.parse(await xml('ppt/presentation.xml')))['p:presentation']);
 const rels = record(record(parser.parse(await xml('ppt/_rels/presentation.xml.rels')))['Relationships']);
 const relationships = array(rels['Relationship']).map(record);
 const pages = array(record(presentation['p:sldIdLst'])['p:sldId']).map(item => {
   const id = string(record(item)['@_r:id']);
   const rel = relationships.find(value => value['@_Id'] === id);
   if (!rel || rel['@_TargetMode'] === 'External') throw new Error('Invalid slide relationship.');
   const target = string(rel['@_Target']);
   const part = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'ppt/' + target);
   if (!part.startsWith('ppt/slides/')) throw new Error('Invalid slide part.');
   return part;
 });
 if (!pages.length || pages.length > 200) throw new Error('Unsupported slide namespace or page count.');
 const diagnostics: Diagnostic[] = [], objects: ArtifactObject[] = [], pageXml: string[] = [];
 for (const entry of Object.keys(zip.files)) {
  if (/\.(emf|wmf)$/i.test(entry)) diagnostics.push({ code: 'unsupported-vector-media', message: 'EMF/WMF content requires a compatible conversion backend.', blocking: true });
  if (/vbaProject\.bin$/i.test(entry)) diagnostics.push({ code: 'active-content', message: 'Macro content is outside the supported artifact scope.', blocking: true });
 }
 for (const [index, part] of pages.entries()) {
   const source = await xml(part); pageXml.push(source);
   const page = index + 1;
   const objectIds = new Set<string>();
   const warn = (code: string, message: string) => diagnostics.push({ code, message, page, blocking: true });
   const parts = [part], visited = new Set(parts), sources = [source];
   for (let cursor = 0; cursor < parts.length; cursor++) {
    const parent = parts[cursor]!;
    const relationshipsFile = zip.file(path.posix.dirname(parent) + '/_rels/' + path.posix.basename(parent) + '.rels');
    if (!relationshipsFile) continue;
    for (const link of array(record(record(parser.parse(await relationshipsFile.async('string')))['Relationships'])['Relationship']).map(record)) {
     const type = string(link['@_Type']);
     if (link['@_TargetMode'] === 'External') {
      if (/\/(image|audio|video)$/.test(type)) warn('external-resource', 'External image/media requires explicit network capability.');
      continue;
     }
     if (!/\/(slideLayout|slideMaster|theme|chart)$/.test(type)) continue;
     const target = string(link['@_Target']);
     const inherited = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(parent), target));
     if (!inherited.startsWith('ppt/')) throw new Error('Invalid inherited presentation part.');
     if (visited.has(inherited)) continue;
     if (parts.length >= 4000) throw new Error('Presentation inheritance limit exceeded.');
     visited.add(inherited); parts.push(inherited); sources.push(await xml(inherited));
    }
   }
   const visualSource = sources.join('\n');
   if (/<p:(timing|transition)\b/.test(visualSource)) warn('temporal-content', 'Static rendering does not verify animation or transitions.');
   if (/<p:oleObj\b/.test(visualSource) || /<m:oMath/.test(visualSource)) warn('unsupported-object', 'OLE/math content requires a compatible backend.');
   if (/<(?:mc:AlternateContent|p:contentPart|a:videoFile|a:audioFile)\b/.test(visualSource)) warn('unsupported-object', 'Alternate or embedded media content requires a compatible backend.');
   if (/<c:\w*3DChart\b/.test(visualSource)) warn('unsupported-3d-chart', 'Lightweight chart rendering does not verify native 3D appearance.');
   for (const uri of visualSource.matchAll(/<a:graphicData\b[^>]*\buri="([^"]+)"/g)) {
     if (!['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://schemas.openxmlformats.org/drawingml/2006/table'].includes(uri[1]!)) warn('unsupported-graphic', 'Graphic object is outside the verified support range.');
   }
   for (const match of source.matchAll(/<(p:sp|p:pic|p:graphicFrame)\b[\s\S]*?<\/\1>/g)) {
     const block = match[0];
     const id = /<p:cNvPr\b[^>]*\bid="([^"]+)"/.exec(block)?.[1];
     if (!id) continue;
     if (objectIds.has(id)) warn('ambiguous-object-id', 'Duplicate shape IDs require an unambiguous import/edit adapter.');
     objectIds.add(id);
     const raw = record(record(parser.parse(block))[match[1]!]);
     const textBody = record(raw['p:txBody']);
     const text = array(textBody['a:p']).map(p => array(record(p)['a:r']).map(r => string(record(r)['a:t'])).join('')).join('\n');
     const transform = /<(?:a|p):xfrm\b[\s\S]*?<\/(?:a|p):xfrm>/.exec(block)?.[0];
     const offset = transform && /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(transform);
     const extent = transform && /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(transform);
     const box = offset && extent && !/<p:grpSp\b/.test(source) ? { x: Number(offset[1]) / 914400, y: Number(offset[2]) / 914400, width: Number(extent[1]) / 914400, height: Number(extent[2]) / 914400 } : undefined;
     objects.push({ page, objectId: id, type: match[1]!.slice(2), ...(text ? { text } : {}), ...(box ? { box } : {}) });
   }
 }
 return { zip, pages, pageXml, diagnostics, objects };
}
export async function editPresentation(bytes: Buffer, input: EditInput): Promise<Buffer> {
 const inspected = await inspectPresentation(bytes);
 if (inspected.diagnostics.some(item => item.blocking)) throw new Error('Cannot edit unsupported presentation content without verified preservation.');
 if (!Array.isArray(input.changes) || input.changes.length > 200) throw new Error('Invalid presentation changes.');
 for (const change of input.changes) {
   const index = change.page - 1;
   if (!Number.isInteger(index) || index < 0 || index >= inspected.pages.length) throw new Error('Invalid edit page.');
   const source = inspected.pageXml[index]!;
   if (change.box && /<p:grpSp\b/.test(source)) throw new Error('Group geometry edits are not verified.');
   let found = false;
   const replaced = source.replace(/<(p:sp|p:pic|p:graphicFrame)\b[\s\S]*?<\/\1>/g, block => {
     if (/<p:cNvPr\b[^>]*\bid="([^"]+)"/.exec(block)?.[1] !== change.objectId) return block;
     found = true;
     if (change.text !== undefined) {
       if (!block.startsWith('<p:sp ') && !block.startsWith('<p:sp>')) throw new Error('Text editing is restricted to text shapes; table/chart/image preservation is unsupported.');
       if ([...block.matchAll(/<a:r\b/g)].length !== 1 || [...block.matchAll(/<a:p\b/g)].length !== 1 || /<a:(fld|br)\b/.test(block) || change.text.includes('\n')) throw new Error('Rich-run or multi-paragraph text preservation requires a compatible editor; geometry editing remains available.');
       if (typeof change.text !== 'string' || change.text.length > 20_000 || !/<a:t>/.test(block)) throw new Error('Object text editing is unsupported.');
       let first = true;
       block = block.replace(/<a:t>[\s\S]*?<\/a:t>/g, () => { const text = first ? escapeXml(change.text!) : ''; first = false; return '<a:t>' + text + '</a:t>'; });
     }
     if (change.box) {
       checkBox(change.box);
       const values = change.box;
       if (!/<a:off\b/.test(block) || !/<a:ext\b/.test(block)) throw new Error('Inherited geometry editing is unsupported.');
       block = block.replace(/<a:off\b[^>]*\/>/, '<a:off x="' + Math.round(values.x * 914400) + '" y="' + Math.round(values.y * 914400) + '"/>')
         .replace(/<a:ext\b[^>]*\/>/, '<a:ext cx="' + Math.round(values.width * 914400) + '" cy="' + Math.round(values.height * 914400) + '"/>');
     }
     return block;
   });
   if (!found) throw new Error('Unknown presentation object.');
   inspected.pageXml[index] = replaced;
   inspected.zip.file(inspected.pages[index]!, replaced);
 }
 return inspected.zip.generateAsync({ type: 'nodebuffer' });
}
