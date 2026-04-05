import process from "node:process";
import { Stream } from "node:stream";
import type { ReactNode } from "react";
import Ink from "../../../../node_modules/ink/build/ink.js";
import type {
  Instance as InkRenderInstance,
  RenderOptions as InkRenderOptions,
} from "../../../../node_modules/ink/build/render.js";

type InkInstance = InstanceType<typeof Ink>;

const localInstances = new WeakMap<NodeJS.WriteStream, InkInstance>();

export type RenderOptions = InkRenderOptions;
export type RenderInstance = InkRenderInstance;

export interface TuiRoot {
  render: (node: ReactNode) => void;
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  clear: () => void;
}

function getOptions(
  stdout: NodeJS.WriteStream | RenderOptions | undefined = {},
): RenderOptions {
  if (stdout instanceof Stream) {
    return {
      stdout,
      stdin: process.stdin,
    };
  }

  return stdout;
}

function getInstance(
  stdout: NodeJS.WriteStream,
  createInstance: () => InkInstance,
  concurrent: boolean,
): InkInstance {
  let instance = localInstances.get(stdout);

  if (!instance) {
    instance = createInstance();
    localInstances.set(stdout, instance);
  } else if (instance.isConcurrent !== concurrent) {
    console.warn(
      `Warning: render() was called with concurrent: ${concurrent}, but the existing renderer for this stdout uses concurrent: ${instance.isConcurrent}. ` +
      `The concurrent option only takes effect on the first render. Call unmount() first if you need to change the rendering mode.`,
    );
  }

  return instance;
}

export function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): RenderInstance {
  const inkOptions = {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    debug: false,
    exitOnCtrlC: true,
    patchConsole: true,
    maxFps: 30,
    incrementalRendering: false,
    concurrent: false,
    ...getOptions(options),
  };

  const instance = getInstance(
    inkOptions.stdout,
    () => new Ink(inkOptions),
    inkOptions.concurrent ?? false,
  );

  instance.render(node);

  return {
    rerender: instance.render,
    unmount() {
      instance.unmount();
    },
    waitUntilExit: instance.waitUntilExit,
    cleanup: () => {
      localInstances.delete(inkOptions.stdout);
    },
    clear: instance.clear,
  };
}

export function createRoot(options: RenderOptions = {}): TuiRoot {
  const inkOptions = {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    debug: false,
    exitOnCtrlC: true,
    patchConsole: true,
    maxFps: 30,
    incrementalRendering: false,
    concurrent: false,
    ...options,
  };

  const instance = new Ink(inkOptions);
  localInstances.set(inkOptions.stdout, instance);

  return {
    render(node) {
      instance.render(node);
    },
    unmount() {
      instance.unmount();
      localInstances.delete(inkOptions.stdout);
    },
    waitUntilExit() {
      return instance.waitUntilExit();
    },
    clear() {
      instance.clear();
    },
  };
}
