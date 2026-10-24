import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten-core';
import variantImport from '@jitl/quickjs-singlefile-cjs-release-sync';

/** Trusted Worker entry. Guest source is only evaluated by QuickJS, never by Node. */
export async function scriptWorkerMain(): Promise<void> {
  const port = parentPort!;
  const data = workerData as {
    code: string; toolNames: string[];
    memoryBytes: number; timeoutMs: number; maxTransferBytes: number; maxCalls: number;
  };
  // The library's PromisedDefault contract handles both Node CJS wrapping and bundled imports.
  const module = await newQuickJSWASMModuleFromVariant(Promise.resolve(variantImport));
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(data.memoryBytes);
  runtime.setMaxStackSize(Math.min(data.memoryBytes / 4, 512 * 1024));
  const deadline = Date.now() + data.timeoutMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  const pending = new Map<number, QuickJSDeferredPromise>();
  let sequence = 0;
  let closed = false;
  let evaluation: QuickJSHandle | undefined;
  function finish(value: { kind: 'done'; value: unknown } | { kind: 'failed'; error: string }): void {
    if (closed) return;
    closed = true;
    port.postMessage(value);
    for (const promise of pending.values()) promise.dispose();
    pending.clear();
    evaluation?.dispose();
    vm.dispose(); runtime.dispose(); port.close();
  }
  function drain(): void {
    if (closed || !evaluation) return;
    try {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) { const error = JSON.stringify(vm.dump(jobs.error)); jobs.error.dispose(); throw new Error(error); }
      const state = vm.getPromiseState(evaluation);
      if (state.type === 'pending') return;
      if (state.type === 'rejected') {
        const error = JSON.stringify(vm.dump(state.error)); state.error.dispose(); throw new Error(error);
      }
      const text = vm.getString(state.value); state.value.dispose();
      if (pending.size) throw new Error('Script returned with unawaited tool calls; effects must be reconciled from receipts.');
      if (Buffer.byteLength(text) > data.maxTransferBytes) throw new Error('Script output exceeds the transfer limit.');
      finish({ kind: 'done', value: (JSON.parse(text) as { value?: unknown }).value });
    } catch (error) { finish({ kind: 'failed', error: String(error).slice(0, data.maxTransferBytes) }); }
  }
  try {
    const call = vm.newFunction('__hostCall', (name, input) => {
      if (++sequence > data.maxCalls) throw new Error('Script tool-call limit exceeded.');
      const nameText = vm.getString(name);
      const inputText = vm.getString(input);
      if (Buffer.byteLength(nameText) + Buffer.byteLength(inputText) > data.maxTransferBytes) throw new Error('Script tool input exceeds the transfer limit.');
      const promise = vm.newPromise();
      pending.set(sequence, promise);
      port.postMessage({ kind: 'call', id: sequence, name: nameText, input: inputText });
      return promise.handle;
    });
    vm.setProp(vm.global, '__hostCall', call); call.dispose();
    vm.unwrapResult(vm.evalCode(`globalThis.tools = Object.freeze(Object.fromEntries(${JSON.stringify(data.toolNames)}.map(name => [name, input => __hostCall(name, JSON.stringify(input ?? {}))])));`)).dispose();
    port.on('message', (message: { id: number; result: string }) => {
      const promise = pending.get(message.id);
      if (closed || !promise) return;
      pending.delete(message.id);
      try {
        const value = vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(message.result)})`));
        promise.resolve(value); value.dispose(); promise.dispose(); drain();
      } catch (error) { promise.dispose(); finish({ kind: 'failed', error: String(error) }); }
    });
    evaluation = vm.unwrapResult(vm.evalCode(`(async () => JSON.stringify({value: await (async () => {\n${data.code}\n})()}))()`));
    drain();
  } catch (error) { finish({ kind: 'failed', error: String(error) }); }
}
