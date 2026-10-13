export type VisualKind = 'static' | 'paginated' | 'interactive' | 'temporal';
export interface Diagnostic { readonly code: string; readonly message: string; readonly page?: number; readonly blocking?: boolean }
type FileRef = { readonly path: string; readonly sourceHash: string };
export type PresentationRef = FileRef & { readonly format: 'pptx'; readonly pages: number };
export type ArtifactRef = PresentationRef | (FileRef & { readonly format: 'pdf'; readonly pages: number })
 | (FileRef & { readonly format: 'docx' | 'png' | 'jpeg' | 'webp' | 'svg' | 'html'; readonly pages?: never });
export type VisualSource =
 | { readonly kind: 'file'; readonly file: ArtifactRef; readonly dependencies?: readonly { readonly path: string; readonly sha256: string }[] }
 | { readonly kind: 'surface'; readonly target: string; readonly observedAt: string; readonly revision?: string; readonly sourceHash?: never };
export type EvidenceLocator =
 | { readonly kind: 'static'; readonly region?: readonly [number, number, number, number] }
 | { readonly kind: 'paginated'; readonly page: number; readonly sheet?: string; readonly range?: string }
 | { readonly kind: 'interactive'; readonly target: string; readonly state: string; readonly viewport: readonly [number, number]; readonly camera?: string; readonly sequence: number }
 | { readonly kind: 'temporal'; readonly time: number; readonly frame?: number };
export interface RasterEvidence { readonly path: string; readonly sha256: string; readonly mediaType: 'image/png'; readonly width: number; readonly height: number; readonly locator: EvidenceLocator }
interface EvidenceBatchBase {
 readonly source: VisualSource; readonly evidence: readonly RasterEvidence[];
 readonly diagnostics: readonly Diagnostic[]; readonly scope: { readonly pages?: readonly number[]; readonly locators?: readonly EvidenceLocator[]; readonly temporal?: { readonly start: number; readonly end: number; readonly coverage: 'sampled' | 'continuous' } };
 readonly engine: { readonly name: string; readonly version: string };
 readonly background?: string;
}
export type VisualEvidenceBatch = EvidenceBatchBase & (
 | { readonly kind: 'paginated'; readonly layout: { readonly totalPages: number; readonly pages: readonly { readonly page: number; readonly width: number; readonly height: number; readonly rotation: number; readonly scale: number }[] } }
 | { readonly kind: 'static' | 'interactive' | 'temporal'; readonly layout?: never });
export interface VisualRequirement {
 readonly background?: string;
 readonly source: VisualSource; readonly kind: VisualKind; readonly pages?: readonly number[];
 readonly target?: string; readonly states?: readonly string[]; readonly times?: readonly number[];
 readonly locators?: readonly EvidenceLocator[];
 readonly temporal?: { readonly start: number; readonly end: number; readonly coverage: 'sampled' | 'continuous' };
}
export type CaptureInput = { readonly target: string; readonly expectedSource?: VisualSource; readonly background?: string } &
 { [Kind in VisualKind]: { readonly kind: Kind; readonly locators: readonly Extract<EvidenceLocator, { readonly kind: Kind }>[] } }[VisualKind];
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type PresentationElement =
 | (Box & { readonly type: 'text'; readonly text: string; readonly fontSize?: number; readonly fontFace?: string; readonly color?: string })
 | (Box & { readonly type: 'rectangle'; readonly color: string })
 | (Box & { readonly type: 'image'; readonly path: string })
 | (Box & { readonly type: 'table'; readonly rows: readonly (readonly string[])[] })
 | (Box & { readonly type: 'chart'; readonly categories: readonly string[]; readonly values: readonly number[]; readonly name?: string });
export interface PresentationInput { readonly slides: readonly { readonly elements: readonly PresentationElement[] }[]; readonly output: string }
export interface FileInput { readonly path: string; readonly expectedSourceHash?: string }
export interface EditInput extends FileInput {
 readonly expectedSourceHash: string; readonly output: string;
 readonly changes: readonly { readonly page: number; readonly objectId: string; readonly text?: string; readonly box?: Box }[];
}
export interface RenderInput extends FileInput { readonly pages?: readonly number[]; readonly backend?: 'lightweight' | 'libreoffice' }
export interface ArtifactObject { readonly page: number; readonly objectId: string; readonly type: string; readonly text?: string; readonly box?: Box }
interface ResultFields {
 readonly artifact?: ArtifactRef; readonly objects?: readonly ArtifactObject[];
 readonly evidence?: VisualEvidenceBatch; readonly diagnostics: readonly Diagnostic[];
 readonly capabilities?: readonly ArtifactCapability[];
 readonly component?: 'browser'; readonly engine?: { readonly name: string; readonly version: string };
 readonly image?: EvidenceImage;
}
export interface EvidenceImage { readonly mediaType: 'image/png'; readonly dataBase64: string; readonly sha256: string; readonly width: number; readonly height: number }
export interface ArtifactInputs {
 create: PresentationInput; open: FileInput; edit: EditInput; export: FileInput & { readonly output: string };
 render: RenderInput; capture: CaptureInput; capabilities: Record<string, never>; prepare: Record<string, never>;
 readEvidence: { readonly source: VisualSource; readonly raster: RasterEvidence };
}
export type ArtifactOperation = keyof ArtifactInputs;
export interface ArtifactCapability {
 readonly operation: ArtifactOperation; readonly input: ArtifactRef['format'] | 'surface' | 'runtime' | 'raster';
 readonly backend?: RenderInput['backend'];
 readonly availability: 'available' | 'not-prepared' | 'unsupported';
 readonly engine?: { readonly name: string; readonly version: string }; readonly diagnostics: readonly Diagnostic[];
}
type Outcome<Payload> = ({ readonly status: 'ready'; readonly diagnostics: readonly Diagnostic[] } & Payload)
 | ({ readonly status: 'unverified'; readonly diagnostics: readonly Diagnostic[] } & Partial<Payload>);
export interface ArtifactResults {
 create: Outcome<{ readonly artifact: PresentationRef }>; edit: Outcome<{ readonly artifact: PresentationRef }>;
 export: Outcome<{ readonly artifact: PresentationRef }>; open: Outcome<{ readonly artifact: ArtifactRef; readonly objects?: readonly ArtifactObject[] }>;
 render: Outcome<{ readonly artifact: ArtifactRef; readonly evidence: VisualEvidenceBatch }>;
 capture: Outcome<{ readonly evidence: VisualEvidenceBatch }>;
 capabilities: Outcome<{ readonly capabilities: readonly ArtifactCapability[] }>;
 prepare: Outcome<{ readonly component: 'browser'; readonly engine: { readonly name: string; readonly version: string } }>;
 readEvidence: Outcome<{ readonly image: EvidenceImage }>;
}
export type ArtifactRequest<Operation extends ArtifactOperation = ArtifactOperation> =
 { [Key in Operation]: { readonly operation: Key; readonly input: ArtifactInputs[Key] } }[Operation];
export type ArtifactResult<O extends ArtifactOperation = ArtifactOperation> = ArtifactResults[O] & ResultFields;
export interface ArtifactExecutionPort { execute<O extends ArtifactOperation>(request: ArtifactRequest<O>, signal?: AbortSignal): Promise<ArtifactResults[O]> }
