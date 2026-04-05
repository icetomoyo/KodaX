import React, { useInsertionEffect, useMemo } from "react";
import {
  Box,
  useTerminalOutput,
  useTerminalSize,
  useTerminalWrite,
} from "../index.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";

export interface AlternateScreenProps {
  children: React.ReactNode;
  mouseTracking?: boolean;
  enabled?: boolean;
}

export const AlternateScreen: React.FC<AlternateScreenProps> = ({
  children,
  mouseTracking = true,
  enabled = true,
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

    if (!writeRaw(
      ENTER_ALT_SCREEN
      + CLEAR_AND_HOME
      + (mouseTracking ? ENABLE_MOUSE_TRACKING : ""),
    )) {
      return;
    }

    return () => {
      writeRaw(
        (mouseTracking ? DISABLE_MOUSE_TRACKING : "")
        + EXIT_ALT_SCREEN,
      );
    };
  }, [isInteractiveStdout, mouseTracking, writeRaw]);

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
