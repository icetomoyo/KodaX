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
  useStdout as inkUseStdout,
  useStdin as inkUseStdin,
  useApp as inkUseApp,
} from "ink";
import {
  render as localRender,
  type RenderOptions,
} from "./root.js";

type InkRenderOptions = RenderOptions;
type StdoutState = ReturnType<typeof inkUseStdout>;
type StdinState = ReturnType<typeof inkUseStdin>;
type AppState = ReturnType<typeof inkUseApp>;
type OutputStream = StdoutState["stdout"];
type InputStream = StdinState["stdin"];
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
  stdout: StdoutState["stdout"];
  stdin: StdinState["stdin"];
  setRawMode: StdinState["setRawMode"];
  isRawModeSupported: StdinState["isRawModeSupported"];
  exit: AppState["exit"];
  terminalSize: TerminalSize;
  isTTY: boolean;
  writeRaw: (chunk: string) => boolean;
  subscribeInput: TerminalInputController["subscribe"];
}

const TuiRuntimeContext = createContext<TuiRuntimeContextValue | null>(null);

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
  renderOptions?: InkRenderOptions;
}

const TuiRuntimeProvider: React.FC<TuiRuntimeProviderProps> = ({
  children,
  renderOptions,
}) => {
  const stdoutState = inkUseStdout();
  const stdinState = inkUseStdin();
  const appState = inkUseApp();
  const output = renderOptions?.stdout ?? stdoutState.stdout;
  const input = renderOptions?.stdin ?? stdinState.stdin;
  const [terminalSize, setTerminalSize] = useState<TerminalSize>(
    () => resolveTerminalSize(output),
  );

  useEffect(() => {
    setTerminalSize(resolveTerminalSize(output));

    if (typeof output?.on !== "function" || typeof output?.off !== "function") {
      return;
    }

    const handleResize = () => {
      setTerminalSize(resolveTerminalSize(output));
    };

    output.on("resize", handleResize);
    return () => {
      output.off?.("resize", handleResize);
    };
  }, [output]);

  const writeRaw = useCallback((chunk: string): boolean => {
    if (typeof output?.write !== "function") {
      return false;
    }

    output.write(chunk);
    return true;
  }, [output]);

  const inputController = useMemo(
    () => createTerminalInputController({
      stdin: input,
      setRawMode: stdinState.setRawMode,
      isRawModeSupported: stdinState.isRawModeSupported,
    }),
    [input, stdinState.isRawModeSupported, stdinState.setRawMode],
  );

  useEffect(() => () => {
    inputController.dispose();
  }, [inputController]);

  const runtime = useMemo<TuiRuntimeContextValue>(() => ({
    stdout: output,
    stdin: input,
    setRawMode: stdinState.setRawMode,
    isRawModeSupported: stdinState.isRawModeSupported,
    exit: appState.exit,
    terminalSize,
    isTTY: output?.isTTY === true,
    writeRaw,
    subscribeInput: inputController.subscribe,
  }), [
    appState.exit,
    input,
    inputController.subscribe,
    stdinState.isRawModeSupported,
    stdinState.setRawMode,
    output,
    terminalSize,
    writeRaw,
  ]);

  return (
    <TuiRuntimeContext.Provider value={runtime}>
      {children}
    </TuiRuntimeContext.Provider>
  );
};

export function render(
  node: React.ReactNode,
  options?: InkRenderOptions,
): ReturnType<typeof localRender> {
  return localRender(
    <TuiRuntimeProvider renderOptions={options}>
      {node}
    </TuiRuntimeProvider>,
    options,
  );
}

export const Box = InkBox;
export const Text = InkText;
export const Static = InkStatic;
export const useInput = inkUseInput;

export function useStdout(): StdoutState {
  const inkState = inkUseStdout();
  const runtime = useContext(TuiRuntimeContext);

  if (!runtime) {
    return inkState;
  }

  return {
    ...inkState,
    stdout: runtime.stdout ?? inkState.stdout,
  };
}

export function useStdin(): StdinState {
  const inkState = inkUseStdin();
  const runtime = useContext(TuiRuntimeContext);

  if (!runtime) {
    return inkState;
  }

  return {
    ...inkState,
    stdin: runtime.stdin ?? inkState.stdin,
    setRawMode: runtime.setRawMode,
    isRawModeSupported: runtime.isRawModeSupported,
  };
}

export function useApp(): AppState {
  const inkState = inkUseApp();
  const runtime = useContext(TuiRuntimeContext);

  if (!runtime) {
    return inkState;
  }

  return {
    ...inkState,
    exit: runtime.exit,
  };
}

export function useTerminalOutput(): OutputStream {
  const inkState = inkUseStdout();
  const runtime = useContext(TuiRuntimeContext);
  return runtime?.stdout ?? inkState.stdout;
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
