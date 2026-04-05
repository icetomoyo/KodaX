import process from "node:process";
import { Stream } from "node:stream";
import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import {
  default as InkBox,
} from "./substrate/ink/components/Box.js";
import {
  default as InkText,
} from "./substrate/ink/components/Text.js";
import {
  default as InkStatic,
} from "./substrate/ink/components/Static.js";
import Ink from "./substrate/ink/ink.js";

type InkInstance = InstanceType<typeof Ink>;

const localInstances = new WeakMap<NodeJS.WriteStream, InkInstance>();

export interface RenderOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  debug?: boolean;
  exitOnCtrlC?: boolean;
  patchConsole?: boolean;
  onRender?: (metrics: { renderTime: number }) => void;
  isScreenReaderEnabled?: boolean;
  maxFps?: number;
  incrementalRendering?: boolean;
  concurrent?: boolean;
  kittyKeyboard?: {
    mode?: "auto" | "enabled" | "disabled";
    flags?: string[];
  };
}

export interface RenderInstance {
  rerender: (node: ReactNode) => void;
  unmount: (error?: unknown) => void;
  waitUntilExit: () => Promise<unknown>;
  cleanup: () => void;
  clear: () => void;
}

export interface Key {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
  super: boolean;
  hyper: boolean;
  capsLock: boolean;
  numLock: boolean;
  eventType?: "press" | "repeat" | "release";
}

export interface TextProps extends PropsWithChildren {
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  wrap?: "wrap" | "truncate" | "truncate-middle";
  "aria-label"?: string;
  "aria-hidden"?: boolean;
}

export type BoxProps = PropsWithChildren<Record<string, unknown>>;

export interface StaticProps<Item> {
  items: readonly Item[];
  children: (item: Item, index: number) => ReactNode;
  style?: Record<string, unknown>;
}

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

export const Box = InkBox as unknown as ComponentType<BoxProps>;
export const Text = InkText as unknown as ComponentType<TextProps>;
export const Static = InkStatic as unknown as (<Item>(
  props: StaticProps<Item>,
) => ReactNode);
