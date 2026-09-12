import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { KodaXExtensionRuntime } from '@kodax-ai/coding';
import type { ClientCommandInput, ClientCommandResult, ClientCommandService, ClientReviewInput } from '@kodax-ai/coding/client-contract';
import type { RuntimeReviewPreparationService, RuntimePreparedReview } from './runtime-review-preparation.js';
import type { RuntimeInvocationService, RuntimePreparedCommandInvocation } from './runtime-invocations.js';

export type RuntimeCommandInvocation = Omit<RuntimePreparedCommandInvocation, 'source'> & { readonly source: 'prompt' | 'extension' };

export interface RuntimeProductCommandService {
  readCommandPrompt: ClientCommandService['readPrompt'];
  startReview(input: ClientReviewInput): Promise<ClientCommandResult>;
  startAgentsLean(input: Omit<ClientReviewInput, 'args'>): Promise<ClientCommandResult>;
  executeCommand(input: ClientCommandInput): Promise<ClientCommandResult>;
}

export interface RuntimeCommandContext {
  readonly projectRoot: string;
  readonly workingDirectory: string;
}

/** Host executes trusted handlers; the client receives only their concrete result. */
export function createRuntimeProductCommandService(deps: {
  readonly extensionRuntime: KodaXExtensionRuntime;
  readonly prepareCommand: RuntimeInvocationService['prepareCommand'];
  readonly reviewPreparation: RuntimeReviewPreparationService;
  readonly startReviewWorkflow: (input: ClientReviewInput, projectRoot: string, workflow: Extract<RuntimePreparedReview, {kind: 'workflow'}>['workflow']) => Promise<ClientCommandResult>;
  readonly startInvocation: (input: ClientCommandInput, invocation: RuntimeCommandInvocation) => Promise<{ readonly runId: string }>;
  readonly withIdleSession: <T>(sessionId: string, execute: (context: RuntimeCommandContext) => Promise<T>) => Promise<T>;
}): RuntimeProductCommandService {
  return {
    readCommandPrompt: (input) => deps.withIdleSession(input.sessionId, async (context) => {
      const prepared = await deps.prepareCommand({ projectRoot: context.projectRoot, name: input.name });
      if (prepared.kind !== 'prepared' || prepared.invocation.userInvocable === false) return null;
      return { title: prepared.invocation.displayName,
        text: [prepared.invocation.prompt, input.args?.join(' ')].filter(Boolean).join('\n\n') };
    }),
    startReview: (input) => deps.withIdleSession(input.sessionId, async (context): Promise<ClientCommandResult> => {
      const prepared = await deps.reviewPreparation.prepareReview({ projectRoot: context.projectRoot, sessionId: input.sessionId, args: input.args ?? [] });
      if (prepared.kind === 'empty') return { kind: 'completed', success: true, message: 'No changes to review.' };
      if (prepared.kind === 'error') return { kind: 'completed', success: false, message: prepared.message };
      if (prepared.kind === 'workflow') return deps.startReviewWorkflow(input, context.projectRoot, prepared.workflow);
      const started = await deps.startInvocation({ ...input, name: 'review' }, prepared.invocation);
      return { kind: 'started', runId: started.runId };
    }),
    startAgentsLean: (input) => deps.withIdleSession(input.sessionId, async (context): Promise<ClientCommandResult> => {
      const prepared = await deps.reviewPreparation.prepareAgentsLean({ projectRoot: context.projectRoot });
      if (prepared.kind === 'missing') return { kind: 'completed', success: false, message: 'AGENTS.md does not exist. Initialize it before running /agents lean.' };
      const started = await deps.startInvocation({ ...input, name: 'agents', args: ['lean'] }, prepared.invocation);
      return { kind: 'started', runId: started.runId };
    }),
    async executeCommand(input) {
      return deps.withIdleSession(input.sessionId, async (context): Promise<ClientCommandResult> => {
        const helpRequested = ['help', '--help', '-h'].includes(input.args?.[0]?.trim().toLowerCase() ?? '');
        const prompt = await deps.prepareCommand({ projectRoot: context.projectRoot, name: input.name });
        if (prompt.kind === 'prepared') {
          if (prompt.invocation.userInvocable === false) throw new Error(`Command is not user-invocable: ${input.name}`);
          if (helpRequested) {
            const description = prompt.invocation.frontmatter?.description;
            return { kind: 'completed', success: true, message: [
              `/${prompt.invocation.displayName}`,
              typeof description === 'string' ? description : undefined,
              `Usage: /${input.name}${prompt.invocation.argumentHint ? ` ${prompt.invocation.argumentHint}` : ''}`,
            ].filter(Boolean).join('\n\n') };
          }
          const started = await deps.startInvocation(input, prompt.invocation);
          return { kind: 'started', runId: started.runId };
        }
        const command = deps.extensionRuntime.getCommand(input.name);
        if (!command || command.metadata?.userInvocable === false) {
          throw Object.assign(new Error(`Registered command is unavailable: ${input.name}`), { code: 'not_found' });
        }
        if (helpRequested) return { kind: 'completed', success: true, message: [
          `/${command.name}`,
          command.aliases?.length ? `Aliases: ${command.aliases.join(', ')}` : undefined,
          command.description,
          `Usage: ${command.usage ?? `/${command.name}`}`,
        ].filter(Boolean).join('\n\n') };
        const log = (level: 'debug' | 'info' | 'warn' | 'error', parts: unknown[]) => emitKodaXDiagnostic({
          source: `host:command:${command.name}`, level,
          message: parts.map((part) => typeof part === 'string' ? part : String(part)).join(' '),
        });
        const result = await command.handler([...(input.args ?? [])], {
          sessionId: input.sessionId, gitRoot: context.projectRoot, workingDirectory: context.workingDirectory,
          reloadExtensions: () => deps.extensionRuntime.reloadExtensions(),
          getDiagnostics: () => deps.extensionRuntime.getDiagnostics(),
          logger: {
            debug: (...parts) => log('debug', parts), info: (...parts) => log('info', parts),
            warn: (...parts) => log('warn', parts), error: (...parts) => log('error', parts),
          },
        });
        if (result?.invocation) {
          const started = await deps.startInvocation(input, {
            ...result.invocation, source: 'extension', displayName: result.invocation.displayName ?? command.name,
          });
          return { kind: 'started', runId: started.runId,
            ...(result.message !== undefined ? { message: result.message } : {}) };
        }
        return { kind: 'completed', success: result?.success !== false,
          ...(result?.message !== undefined ? { message: result.message } : {}) };
      });
    },
  };
}
