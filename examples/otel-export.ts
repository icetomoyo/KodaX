/**
 * FEATURE_083 (v0.7.24) — OpenTelemetry export example.
 *
 * Shows how to plug KodaX's `@kodax/tracing` primitives into any external
 * observability system (OpenTelemetry, Langfuse, Datadog, a custom sink,
 * ...) by implementing the `TracingProcessor` interface.
 *
 * Run with tsx:
 *
 *     npx tsx examples/otel-export.ts
 *
 * The example uses a small "pseudo OTel exporter" that just logs to stdout
 * in OTLP-ish JSON so the file has no hard dependency on
 * @opentelemetry/api. A real integration would forward these spans to
 * `trace.getTracer(...).startSpan(...)` instead.
 */

import {
  Runner,
  createAgent,
  type AgentMessage,
} from '@kodax/core';
import {
  Tracer,
  addTracingProcessor,
  setTracingProcessors,
  shutdownTracing,
  type Span,
  type Trace,
  type TracingProcessor,
} from '@kodax/tracing';

/**
 * Pseudo OpenTelemetry exporter. In a real app replace the `export*` stubs
 * with calls to an OpenTelemetry SDK `SpanExporter`.
 */
class PseudoOtelProcessor implements TracingProcessor {
  onSpanStart(span: Span): void {
    // OTLP typically does not report start-only events to the backend;
    // real adapters would buffer the span and emit on end.
    console.log(`[otel] span.start  trace=${span.traceId} span=${span.id} name=${span.name} kind=${span.data.kind}`);
  }

  onSpanEnd(span: Span): void {
    const durationMs = span.endedAt !== undefined ? span.endedAt - span.startedAt : 0;
    const attributes: Record<string, unknown> = {
      'kodax.span.kind': span.data.kind,
      'kodax.span.name': span.name,
      ...extractAttributes(span),
    };
    const otlpSpan = {
      traceId: span.traceId,
      spanId: span.id,
      parentSpanId: span.parentId,
      name: span.name,
      startTimeUnixNano: span.startedAt * 1_000_000,
      endTimeUnixNano: (span.endedAt ?? Date.now()) * 1_000_000,
      durationMs,
      attributes,
      status: span.error ? { code: 'ERROR', message: span.error.message } : { code: 'OK' },
    };
    console.log('[otel] span.end   ', JSON.stringify(otlpSpan));
  }

  onTraceEnd(trace: Trace): void {
    console.log(`[otel] trace.end  trace=${trace.id} rootName=${trace.rootSpan.name}`);
  }

  async shutdown(): Promise<void> {
    console.log('[otel] flush & shutdown');
  }
}

function extractAttributes(span: Span): Record<string, unknown> {
  const { data } = span;
  // Kind-specific attribute extraction. A real OTel adapter would map these
  // onto semantic conventions (e.g. `gen_ai.request.model`).
  switch (data.kind) {
    case 'generation':
      return {
        'gen_ai.request.model': data.model,
        'gen_ai.request.provider': data.provider,
        'gen_ai.usage.input_tokens': data.usage?.inputTokens,
        'gen_ai.usage.output_tokens': data.usage?.outputTokens,
      };
    case 'tool_call':
      return {
        'tool.name': data.toolName,
        'tool.status': data.status,
      };
    case 'agent':
      return {
        'kodax.agent.name': data.agentName,
      };
    default:
      return {};
  }
}

async function main(): Promise<void> {
  // Register the pseudo exporter. In a real app, you might also keep the
  // built-in ConsoleTracingProcessor for local debugging:
  //
  //   addTracingProcessor(new ConsoleTracingProcessor());
  //   addTracingProcessor(new PseudoOtelProcessor());
  setTracingProcessors([new PseudoOtelProcessor()]);

  const agent = createAgent({
    name: 'haiku-writer',
    instructions: 'Write one short haiku in response to any prompt.',
    provider: 'mock',
    model: 'mock-haiku',
  });

  const mockLlm = async (messages: readonly AgentMessage[]): Promise<string> => {
    const subject = typeof messages[messages.length - 1]?.content === 'string'
      ? (messages[messages.length - 1]?.content as string)
      : 'the morning';
    return [
      `soft light on ${subject}`,
      'ink drying on folded notes',
      'birds outrun the dawn',
    ].join('\n');
  };

  const tracer = new Tracer();
  const result = await Runner.run(agent, 'the river', {
    llm: mockLlm,
    tracer,
  });

  console.log('\n--- haiku ---\n' + result.output + '\n');

  await shutdownTracing();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
