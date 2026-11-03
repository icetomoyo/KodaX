import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten-core';
import variantImport from '@jitl/quickjs-singlefile-cjs-release-sync';
import { createScriptControlBudget } from './control.js';

/** Trusted Worker entry. Guest source is only evaluated by QuickJS, never by Node. */
export async function scriptWorkerMain(): Promise<void> {
  const port = parentPort!;
  const data = workerData as {
    code: string; toolNames: string[];
    storedValues?: [string, string][];
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
  const stored = new Map(data.storedValues ?? []);
  const chargeControl = createScriptControlBudget(data);
  let yielded = false;
  const pending = new Map<number, QuickJSDeferredPromise>();
  let sequence = 0;
  let readSequence = 0;
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
    const store = vm.newFunction('__store', (key, value) => {
      const name = vm.getString(key);
      const encoded = vm.getString(value);
      const next = new Map(stored);
      if (encoded) next.set(name, encoded); else next.delete(name);
      const bytes = [...next].reduce((sum, [entry, text]) => sum + Buffer.byteLength(entry) + Buffer.byteLength(text), 0);
      if (next.size > 128 || bytes > data.maxTransferBytes) throw new Error('Script Run store exceeds 128 entries or the transfer-byte limit.');
      chargeControl(Buffer.byteLength(name) + Buffer.byteLength(encoded));
      if (encoded) stored.set(name, encoded); else stored.delete(name);
      port.postMessage({ kind: 'store', name, value: encoded || undefined });
    });
    vm.setProp(vm.global, '__store', store); store.dispose();
    const load = vm.newFunction('__load', key => vm.newString(stored.get(vm.getString(key)) ?? ''));
    vm.setProp(vm.global, '__load', load); load.dispose();
    const emit = vm.newFunction('__emit', text => {
      const value = vm.getString(text);
      chargeControl(Buffer.byteLength(value));
      port.postMessage({ kind: 'output', value });
    });
    vm.setProp(vm.global, '__emit', emit); emit.dispose();
    const yieldControl = vm.newFunction('yield_control', () => {
      if (yielded) return;
      chargeControl(0); yielded = true; port.postMessage({ kind: 'yield' });
    });
    vm.setProp(vm.global, 'yield_control', yieldControl); yieldControl.dispose();
    const readResult = vm.newFunction('read_result', (id, offset) => {
      if (id === undefined) throw new Error('read_result requires a result reference call ID.');
      const callId = vm.getNumber(id);
      const position = offset === undefined || vm.typeof(offset) === 'undefined' ? 0 : vm.getNumber(offset);
      if (!Number.isSafeInteger(callId) || callId < 1 || !Number.isSafeInteger(position) || position < 0) throw new Error('read_result requires a positive call ID and non-negative integer offset.');
      chargeControl(Buffer.byteLength(String(callId)) + Buffer.byteLength(String(position)));
      const promise = vm.newPromise();
      const requestId = --readSequence;
      pending.set(requestId, promise);
      port.postMessage({ kind: 'result_read', id: requestId, callId, offset: position });
      return promise.handle;
    });
    vm.setProp(vm.global, 'read_result', readResult); readResult.dispose();
    vm.unwrapResult(vm.evalCode(`
      globalThis.store = (key, value) => {
        if (typeof key !== 'string') throw new TypeError('Store key must be a string');
        if (value === undefined) { __store(key, ''); return; }
        const seen = new Set();
        const check = value => {
          if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
          if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length) throw new TypeError('Store accepts acyclic JSON values only');
          seen.add(value); for (const child of Object.values(value)) check(child); seen.delete(value);
        };
        check(value); __store(key, JSON.stringify(value));
      };
      globalThis.load = key => { const value = __load(String(key)); return value ? JSON.parse(value) : undefined; };
      globalThis.text = value => __emit(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
    `)).dispose();
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
