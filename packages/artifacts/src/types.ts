export type VisualKind = 'static' | 'paginated' | 'interactive' | 'temporal';
export interface Diagnostic { readonly code: string; readonly message: string; readonly page?: number; readonly blocking?: boolean }
export interface ArtifactRef { readonly path: string; readonly sourceHash: string; readonly kind: 'presentation'; readonly pages: number }
export type EvidenceLocator =
 | { readonly kind: 'static'; readonly region?: readonly [number, number, number, number] }
 | { readonly kind: 'paginated'; readonly page: number; readonly sheet?: string; readonly range?: string }
 | { readonly kind: 'interactive'; readonly target: string; readonly state: string; readonly viewport: readonly [number, number]; readonly camera?: string; readonly sequence: number }
 | { readonly kind: 'temporal'; readonly time: number; readonly frame?: number };
export interface RasterEvidence { readonly path: string; readonly sha256: string; readonly mediaType: 'image/png'; readonly locator: EvidenceLocator }
export interface VisualEvidenceBatch {
 readonly kind: VisualKind; readonly sourceHash: string; readonly evidence: readonly RasterEvidence[];
 readonly diagnostics: readonly Diagnostic[]; readonly scope: { readonly pages?: readonly number[]; readonly locators?: readonly EvidenceLocator[]; readonly temporal?: { readonly start: number; readonly end: number; readonly coverage: 'sampled' | 'continuous' } };
 readonly engine?: { readonly name: string; readonly version: string };
}
export interface VisualRequirement {
 readonly sourceHash: string; readonly kind: VisualKind; readonly pages?: readonly number[];
 readonly target?: string; readonly states?: readonly string[]; readonly times?: readonly number[];
 readonly locators?: readonly EvidenceLocator[];
 readonly temporal?: { readonly start: number; readonly end: number; readonly coverage: 'sampled' | 'continuous' };
}
export interface CaptureInput {
 readonly kind: VisualKind; readonly target: string; readonly pages?: readonly number[];
 readonly states?: readonly string[]; readonly times?: readonly number[]; readonly viewport?: readonly [number, number]; readonly camera?: string;
 readonly locators?: readonly EvidenceLocator[];
}
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
export interface ArtifactResult {
 readonly status: 'ready' | 'unverified'; readonly artifact?: ArtifactRef; readonly objects?: readonly ArtifactObject[];
 readonly evidence?: VisualEvidenceBatch; readonly diagnostics: readonly Diagnostic[];
 readonly capabilities?: Readonly<Record<string, string>>;
}
export type ArtifactRequest =
 | { readonly operation: 'create'; readonly input: PresentationInput }
 | { readonly operation: 'open'; readonly input: FileInput }
 | { readonly operation: 'edit'; readonly input: EditInput }
 | { readonly operation: 'export'; readonly input: FileInput & { readonly output: string } }
 | { readonly operation: 'render'; readonly input: RenderInput }
 | { readonly operation: 'capture'; readonly input: CaptureInput }
 | { readonly operation: 'capabilities'; readonly input: Record<string, never> };
export interface ArtifactExecutionPort { execute(request: ArtifactRequest, signal?: AbortSignal): Promise<ArtifactResult> }
