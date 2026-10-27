export { parseGenerationCheckpoint } from '@kodax-ai/coding';
import type { RuntimeKodaXOptions } from './sdk-runtime.js';

export interface RuntimeGenerationResume {
  readonly prompt: string;
  readonly options: RuntimeKodaXOptions;
  readonly requiredBindings: readonly { readonly path: string; readonly type: string }[];
}

const OPTION_KEYS = new Set(['provider', 'model', 'modelOverride', 'effort', 'thinking', 'reasoningMode',
  'agentMode', 'maxIter', 'workflowHostPolicy', 'workflowRunsBaseDir', 'modelTiers', 'maxOutputTokens',
  'disablePromptCache', 'lsp', 'workflow', 'selfManual', 'compaction', 'timeouts', 'sandbox', 'maxConcurrentThreadsPerSession']);
const CONTEXT_KEYS = new Set(['gitRoot', 'executionCwd', 'shellExecution', 'contextTokenSnapshot',
  'projectSnapshot', 'longRunning', 'providerPolicyHints', 'repoRoutingSignals', 'repoIntelligenceMode',
  'repoIntelligenceTrace', 'contextDiagnostics', 'disableAutoTaskReroute', 'toolConstructionMode',
  'skillsPrompt', 'rawUserInput', 'skillInvocation', 'commandInvocation', 'repoIntelligenceContext',
  'inputArtifacts', 'promptOverlay', 'taskSurface', 'liveTurn', 'managedTaskWorkspaceDir',
  'managedProtocolEmission', 'excludeTools', 'systemPromptOverride', 'taskMetadata', 'taskVerification',
  'agentProfile', 'currentAgentId', 'parentAgentId', 'workflowIntent']);

/** Persist resolved input/configuration; process-local authority must be rebound. */
export function captureGenerationResume(input: { readonly prompt: string; readonly options: RuntimeKodaXOptions }): RuntimeGenerationResume {
  const values: Record<string, unknown> = {};
  const required: Array<{ path: string; type: string }> = [];
  const visiting = new WeakSet<object>();
  const requireBinding = (path: string, value: unknown): void => {
    if (path !== 'extensionRuntime' && value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
      if (visiting.has(value)) throw new Error('Generation recovery contains a cyclic authority binding.');
      visiting.add(value);
      for (const [key, item] of Object.entries(value)) if (item !== undefined) requireBinding(`${path}.${key}`, item);
      visiting.delete(value);
    } else required.push({ path, type: typeof value });
  };
  for (const [key, value] of Object.entries(input.options)) {
    if (value === undefined || key === 'toolInvocation' || key === 'session' || key === 'sessionControl' || key === 'abortSignal') continue;
    if (key === 'context' && value !== null && typeof value === 'object') {
      const context: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(value)) {
        if (item === undefined) continue;
        if (CONTEXT_KEYS.has(name)) context[name] = item;
        else requireBinding(`context.${name}`, item);
      }
      values.context = context;
    } else if (OPTION_KEYS.has(key)) values[key] = value;
    else requireBinding(key, value);
  }
  // A supposedly declarative option containing callbacks cannot silently lose them.
  const serialized = JSON.stringify(values, (_key, value: unknown) => {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new Error('Generation recovery configuration contains nonserializable values.');
    }
    return value;
  });
  return { prompt: input.prompt, options: JSON.parse(serialized) as RuntimeKodaXOptions, requiredBindings: required };
}

export function rebindGenerationOptions(resume: RuntimeGenerationResume, supplied: RuntimeKodaXOptions | undefined): RuntimeKodaXOptions {
  const rebound: Record<string, unknown> = {};
  for (const binding of resume.requiredBindings) {
    let value: unknown = supplied;
    const parts = binding.path.split('.');
    for (const key of parts) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { value = undefined; break; }
      value = (value as Record<string, unknown>)[key];
    }
    if (typeof value !== binding.type || value === undefined) throw new Error(`Generation recovery requires a new ${binding.path} binding.`);
    const root = parts[0]! as keyof RuntimeKodaXOptions;
    rebound[root] = supplied?.[root];
  }
  return rebound;
}
