import type { KodaXMessage, KodaXStreamResult, KodaXTokenUsage, KodaXToolDefinition } from '../types.js';
import type { ImageValidation } from '../image-validation.js';

/** Connection metadata only. Privileged Hosts supply credentials through the existing scoped broker. */
export interface KodaXOperationConnection {
  name: string; model: string; baseUrl: string; apiKeyEnv?: string; credentialSource?: 'broker';
}
export type KodaXClassifierApi = 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'openai-decisions' | 'llama-cpp-classify';
export interface KodaXClassifierConnection extends KodaXOperationConnection {
  api: KodaXClassifierApi;
  /** Cloudflare generic Jev envelope or documented flat Clef endpoint; never guessed from model names. */
  dialect?: 'cloudflare-jev' | 'cloudflare-clef' | 'openrouter-system-one';
}
export type KodaXClassificationQuestion = { instructions: string } & (
  | { type: 'bool'; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; criteria: Record<string, string> }
  | { type: 'score'; criteria: string[] });
export interface KodaXClassificationRequest {
  state: unknown; questions: Record<string, KodaXClassificationQuestion>;
  images?: Record<string, KodaXOperationImage>;
  singleAttempt?: boolean;
}
export interface KodaXOperationImage { data: string; mediaType?: string }
export interface KodaXGeneratedImage { data: string; mediaType: string; validation: ImageValidation }
export interface KodaXImageConnection extends KodaXOperationConnection {
  api: 'openrouter-images'; dialect: 'images' | 'chat-completions';
}
export interface KodaXImageRequest {
  prompt: string; images?: KodaXOperationImage[];
  stream?: boolean;
  /** A temporary preview; callers must not register it as the final generated artifact. */
  onPreview?(image: KodaXGeneratedImage, partialImageIndex: number): void | Promise<void>;
  /** Native model options (resolution, aspect_ratio, provider routing, etc.). Core request fields cannot be overridden. */
  parameters?: Record<string, unknown>;
}
export interface KodaXImageResult {
  images: KodaXGeneratedImage[]; text?: string; usage?: KodaXTokenUsage;
  cost?: { amount: number; currency: 'USD'; source: 'reported' };
}
export interface KodaXDeferredConnection extends KodaXOperationConnection {
  api: 'openai-background-responses';
  /** Trusted Host's stable registration/account identifier, never inferred from an unverified token. */
  accountScope: string;
}
export interface KodaXDeferredRequest {
  messages: KodaXMessage[]; tools: KodaXToolDefinition[]; system: string; maxOutputTokens: number;
  effort?: string; store?: boolean;
}
/** Serializable locator only. Each operation still requires fresh authority for this exact connection/account. */
export interface KodaXDeferredReference { version: 1; id: string; scope: string }
export type KodaXDeferredResult = { reference: KodaXDeferredReference } & (
  | { status: 'queued' | 'in_progress' }
  | { status: 'failed' | 'cancelled' | 'incomplete'; reason?: string; partialUsage?: KodaXTokenUsage; usageKind: 'cumulative'; usageId: string }
  | { status: 'completed'; result: KodaXStreamResult; usageKind: 'cumulative'; usageId: string });
export type KodaXClassificationAnswer =
  | { type: 'bool'; probability: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence?: number; probabilities: Record<string, number> }
  | { type: 'refusal' };
export interface KodaXClassificationResult {
  model: string; answers: Record<string, KodaXClassificationAnswer>; usage?: KodaXTokenUsage;
}
