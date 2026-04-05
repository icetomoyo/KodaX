import process from "node:process";
import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  Box as InkBox,
  Text as InkText,
  Static as InkStatic,
  useInput as inkUseInput,
} from "ink";
import {
  render as localRender,
  type RenderOptions,
} from "./root.js";

type InkRenderOptions = RenderOptions;
export interface StdoutState {
  readonly stdout: NodeJS.WriteStream;
}

export interface StdinState {
  readonly stdin: NodeJS.ReadStream;
  readonly setRawMode: (isEnabled: boolean) => void;
  readonly isRawModeSupported: boolean;
}

export interface AppState {
  readonly exit: () => void;
}

type OutputStream = StdoutState["stdout"];
type InputStream = NodeJS.ReadStream;
type TerminalInputChunk = Buffer | string;

interface TerminalInputSource {
  on?: (event: "data", listener: (chunk: TerminalInputChunk) => void) => void;
  off?: (event: "data", listener: (chunk: TerminalInputChunk) => void) => void;
  isRaw?: boolean;
}

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface TerminalInputOptions {
  isActive?: boolean;
  rawMode?: boolean;
}

interface TerminalInputSubscription {
  listener: (data: TerminalInputChunk) => void;
  rawMode: boolean;
}

export interface TerminalInputController {
  subscribe: (
    listener: (data: TerminalInputChunk) => void,
    options?: Pick<TerminalInputOptions, "rawMode">,
  ) => () => void;
  dispose: () => void;
}

function resolveTerminalSize(stdout: OutputStream | undefined): TerminalSize {
  return {
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  };
}

interface TuiRuntimeContextValue {
  stdout: OutputStream;
  stdin: InputStream;
  setRawMode: StdinState["setRawMode"];
  isRawModeSupported: StdinState["isRawModeSupported"];
  exit: AppState["exit"];
  terminalSize: TerminalSize;
  isTTY: boolean;
  writeRaw: (chunk: string) => boolean;
  subscribeInput: TerminalInputController["subscribe"];
}

const TuiRuntimeContext = createContext<TuiRuntimeContextValue | null>(null);

interface MutableTuiRuntimeContextValue extends TuiRuntimeContextValue {
  attachExit: (exit: () => void) => void;
}

function hasRawModeSubscribers(subscriptions: ReadonlySet<TerminalInputSubscription>): boolean {
  for (const subscription of subscriptions) {
    if (subscription.rawMode) {
      return true;
    }
  }

  return false;
}

export function createTerminalInputController({
  stdin,
  setRawMode,
  isRawModeSupported,
}: {
  stdin: TerminalInputSource | undefined;
  setRawMode: StdinState["setRawMode"];
  isRawModeSupported: boolean;
}): TerminalInputController {
  const subscriptions = new Set<TerminalInputSubscription>();
  let attachedInput: TerminalInputSource | undefined;
  let rawModeEnabledByController = false;

  const handleData = (chunk: TerminalInputChunk) => {
    for (const subscription of subscriptions) {
      subscription.listener(chunk);
    }
  };

  const disableRawModeIfOwned = () => {
    if (!rawModeEnabledByController) {
      return;
    }

    try {
      setRawMode(false);
    } catch {
      // Ignore terminals that reject raw-mode restoration during teardown.
    }
    rawModeEnabledByController = false;
  };

  const detachInput = () => {
    attachedInput?.off?.("data", handleData);
    attachedInput = undefined;
    disableRawModeIfOwned();
  };

  const syncInputOwnership = () => {
    if (attachedInput && attachedInput !== stdin) {
      detachInput();
    }

    if (!stdin || subscriptions.size === 0) {
      detachInput();
      return;
    }

    if (attachedInput !== stdin) {
      stdin.on?.("data", handleData);
      attachedInput = stdin;
    }

    const requiresRawMode = isRawModeSupported && hasRawModeSubscribers(subscriptions);
    if (!requiresRawMode) {
      disableRawModeIfOwned();
      return;
    }

    if (stdin.isRaw === false && !rawModeEnabledByController) {
      try {
        setRawMode(true);
        rawModeEnabledByController = true;
      } catch {
        rawModeEnabledByController = false;
      }
    }
  };

  return {
    subscribe(listener, options = {}) {
      const subscription: TerminalInputSubscription = {
        listener,
        rawMode: options.rawMode !== false,
      };
      subscriptions.add(subscription);
      syncInputOwnership();

      return () => {
        subscriptions.delete(subscription);
        syncInputOwnership();
      };
    },
    dispose() {
      subscriptions.clear();
      detachInput();
    },
  };
}

interface TuiRuntimeProviderProps {
  children: React.ReactNode;
  runtime: TuiRuntimeContextValue;
}

const TuiRuntimeProvider: React.FC<TuiRuntimeProviderProps> = ({
  children,
  runtime,
}) => {
  const [terminalSize, setTerminalSize] = useState<TerminalSize>(
    () => runtime.terminalSize,
  );

  useEffect(() => {
    setTerminalSize(resolveTerminalSize(runtime.stdout));

    if (typeof runtime.stdout?.on !== "function" || typeof runtime.stdout?.off !== "function") {
      return;
    }

    const handleResize = () => {
      setTerminalSize(resolveTerminalSize(runtime.stdout));
    };

    runtime.stdout.on("resize", handleResize);
    return () => {
      runtime.stdout.off?.("resize", handleResize);
    };
  }, [runtime.stdout]);

  const writeRaw = useCallback((chunk: string): boolean => {
    if (typeof runtime.stdout?.write !== "function") {
      return false;
    }

    runtime.stdout.write(chunk);
    return true;
  }, [runtime.stdout]);

  const inputController = useMemo(
    () => createTerminalInputController({
      stdin: runtime.stdin,
      setRawMode: runtime.setRawMode,
      isRawModeSupported: runtime.isRawModeSupported,
    }),
    [runtime.stdin, runtime.isRawModeSupported, runtime.setRawMode],
  );

  useEffect(() => () => {
    inputController.dispose();
  }, [inputController]);

  const value = useMemo<TuiRuntimeContextValue>(() => ({
    stdout: runtime.stdout,
    stdin: runtime.stdin,
    setRawMode: runtime.setRawMode,
    isRawModeSupported: runtime.isRawModeSupported,
    exit: runtime.exit,
    terminalSize,
    isTTY: runtime.stdout?.isTTY === true,
    writeRaw,
    subscribeInput: inputController.subscribe,
  }), [
    inputController.subscribe,
    runtime.exit,
    runtime.isRawModeSupported,
    runtime.setRawMode,
    runtime.stdin,
    runtime.stdout,
    inputController.subscribe,
    terminalSize,
    writeRaw,
  ]);

  return (
    <TuiRuntimeContext.Provider value={value}>
      {children}
    </TuiRuntimeContext.Provider>
  );
};

function createRuntimeValue(
  options: InkRenderOptions | undefined,
): MutableTuiRuntimeContextValue {
  const stdout = options?.stdout ?? process.stdout;
  const stdin = options?.stdin ?? process.stdin;
  const setRawMode = (enabled: boolean) => {
    if (typeof stdin?.setRawMode === "function") {
      stdin.setRawMode(enabled);
    }
  };

  let instanceExit: (() => void) | undefined;

  return {
    stdout,
    stdin,
    setRawMode,
    isRawModeSupported: typeof stdin?.setRawMode === "function",
    exit: () => {
      instanceExit?.();
    },
    terminalSize: resolveTerminalSize(stdout),
    isTTY: stdout?.isTTY === true,
    writeRaw: (chunk: string) => {
      if (typeof stdout?.write !== "function") {
        return false;
      }

      stdout.write(chunk);
      return true;
    },
    subscribeInput: () => () => undefined,
    attachExit(exit: () => void) {
      instanceExit = exit;
    },
  };
}

export function render(
  node: React.ReactNode,
  options?: InkRenderOptions,
): ReturnType<typeof localRender> {
  const runtime = createRuntimeValue(options);
  const instance = localRender(
    <TuiRuntimeProvider runtime={runtime}>
      {node}
    </TuiRuntimeProvider>,
    options,
  );

  runtime.attachExit(instance.unmount);
  return instance;
}

export const Box = InkBox;
export const Text = InkText;
export const Static = InkStatic;
export const useInput = inkUseInput;

export function useStdout(): StdoutState {
  const runtime = useContext(TuiRuntimeContext);
  return {
    stdout: runtime?.stdout ?? process.stdout,
  };
}

export function useStdin(): StdinState {
  const runtime = useContext(TuiRuntimeContext);
  const stdin = runtime?.stdin ?? process.stdin;
  const setRawMode = runtime?.setRawMode ?? ((enabled: boolean) => {
    if (typeof stdin?.setRawMode === "function") {
      stdin.setRawMode(enabled);
    }
  });

  return {
    stdin,
    setRawMode,
    isRawModeSupported: runtime?.isRawModeSupported ?? (typeof stdin?.setRawMode === "function"),
  };
}

export function useApp(): AppState {
  const runtime = useContext(TuiRuntimeContext);
  return {
    exit: runtime?.exit ?? (() => undefined),
  };
}

export function useTerminalOutput(): OutputStream {
  const runtime = useContext(TuiRuntimeContext);
  return runtime?.stdout ?? process.stdout;
}

export function useTerminalSize(): TerminalSize {
  const output = useTerminalOutput();
  const runtime = useContext(TuiRuntimeContext);

  return runtime?.terminalSize ?? resolveTerminalSize(output);
}

export function useTerminalWrite(): (chunk: string) => boolean {
  const output = useTerminalOutput();
  const runtime = useContext(TuiRuntimeContext);

  return runtime?.writeRaw ?? ((chunk: string) => {
    if (typeof output?.write !== "function") {
      return false;
    }

    output.write(chunk);
    return true;
  });
}

export function useTerminalInput(
  onData: (data: TerminalInputChunk) => void,
  options: TerminalInputOptions = {},
): void {
  const { isActive = true, rawMode = true } = options;
  const runtime = useContext(TuiRuntimeContext);
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const handlerRef = useRef(onData);

  useEffect(() => {
    handlerRef.current = onData;
  }, [onData]);

  useEffect(() => {
    if (!isActive || !stdin) {
      return;
    }

    if (runtime) {
      return runtime.subscribeInput((chunk) => {
        handlerRef.current(chunk);
      }, { rawMode });
    }

    const input = stdin;
    const wasRaw = input.isRaw;

    if (rawMode && isRawModeSupported && wasRaw === false) {
      setRawMode(true);
    }

    const handleData = (chunk: TerminalInputChunk) => {
      handlerRef.current(chunk);
    };

    input.on?.("data", handleData);

    return () => {
      input.off?.("data", handleData);

      if (rawMode && isRawModeSupported && wasRaw === false) {
        try {
          setRawMode(false);
        } catch {
          // Ignore terminals that reject raw-mode restoration during teardown.
        }
      }
    };
  }, [runtime, stdin, isActive, rawMode, isRawModeSupported, setRawMode]);
}

export type { Key } from "ink";
