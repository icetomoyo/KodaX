import React, { useInsertionEffect, useMemo } from "react";
import {
  Box,
  useTerminalOutput,
  useTerminalSize,
  useTerminalWrite,
} from "../index.js";
import { getRendererInstance } from "../core/root.js";
import {
  buildAlternateScreenEnterSequence,
  buildAlternateScreenExitSequence,
} from "../core/termio.js";

export interface AlternateScreenProps {
  children: React.ReactNode;
  mouseTracking?: boolean;
  enabled?: boolean;
  clearOnEnter?: boolean;
}

export const AlternateScreen: React.FC<AlternateScreenProps> = ({
  children,
  mouseTracking = true,
  enabled = true,
  clearOnEnter = false,
}) => {
  const output = useTerminalOutput();
  const { rows } = useTerminalSize();
  const writeRaw = useTerminalWrite();
  const isInteractiveStdout = useMemo(
    () => enabled && output.isTTY === true,
    [enabled, output],
  );

  useInsertionEffect(() => {
    if (!isInteractiveStdout) {
      return;
    }

    const rendererInstance = getRendererInstance(output);
    rendererInstance?.setShellMode?.("virtual", mouseTracking);
    rendererInstance?.beginShellTransition?.("enter-alt-screen");
    if (!writeRaw(
      buildAlternateScreenEnterSequence({
        mouseTracking,
        clearOnEnter,
      }),
    )) {
      return;
    }
    rendererInstance?.setAltScreenActive?.(true, mouseTracking);

    return () => {
      rendererInstance?.beginShellTransition?.("exit-alt-screen");
      rendererInstance?.clearTextSelection?.();
      rendererInstance?.setAltScreenActive?.(false);
      writeRaw(buildAlternateScreenExitSequence({ mouseTracking }));
    };
  }, [clearOnEnter, isInteractiveStdout, mouseTracking, output, writeRaw]);

  return (
    <Box
      flexDirection="column"
      height={rows}
      width="100%"
      flexGrow={1}
      flexShrink={0}
    >
      {children}
    </Box>
  );
};
