import type { Interface } from 'node:readline';
import type { Writable } from 'node:stream';

/** An output view owned by one readline instance; it never changes global stdout. */
export function createSecretReadlineSurface(output: Writable) {
  let hidden = false;
  const screen = new Proxy(output, { get(target, key) {
    if (key === 'write' && hidden) return (_chunk: unknown, encoding?: unknown, callback?: unknown) => {
      const done = typeof encoding === 'function' ? encoding : callback; if (typeof done === 'function') done(); return true;
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { output: screen, async read(rl: Interface, prompt: string): Promise<string | undefined> {
    if (Reflect.get(rl, 'closed') === true) return undefined;
    if (hidden) throw new Error('A hidden input is already active.');
    output.write(`${prompt} (q to cancel): `); hidden = true;
    const historySize: unknown = Reflect.get(rl, 'historySize'); Reflect.set(rl, 'historySize', 0);
    const cancellation = new AbortController();
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const finish = (answer?: string) => { rl.removeListener('close', onCancel); rl.removeListener('SIGINT', onCancel); resolve(answer === 'q' ? undefined : answer?.trim()); };
        const onCancel = () => { cancellation.abort(); finish(); };
        rl.once('close', onCancel); rl.once('SIGINT', onCancel);
        try { rl.question('', { signal: cancellation.signal }, answer => finish(answer)); }
        catch (error) { rl.removeListener('close', onCancel); rl.removeListener('SIGINT', onCancel); reject(error); }
      });
    } finally { hidden = false; Reflect.set(rl, 'historySize', historySize); output.write('\n'); }
  } };
}
