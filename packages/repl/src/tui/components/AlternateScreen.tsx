import React, { useInsertionEffect, useMemo, useState, useEffect } from "react";
import { Box, useStdout } from "../index.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1006l";

interface TtyOutputLike {
  isTTY?: boolean;
  rows?: number;
  write?: (chunk: string) => unknown;
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
}

function resolveTerminalOutput(stdout: TtyOutputLike | undefined): TtyOutputLike {
  return stdout ?? process.stdout;
}

function useTerminalRows(output: TtyOutputLike): number {
  const [rows, setRows] = useState(() => output.rows ?? process.stdout.rows ?? 24);

  useEffect(() => {
    if (typeof output.on !== "function" || typeof output.off !== "function") {
      setRows(output.rows ?? process.stdout.rows ?? 24);
      return;
    }

    const handleResize = () => {
      setRows(output.rows ?? process.stdout.rows ?? 24);
    };

    output.on("resize", handleResize);
    return () => {
      output.off?.("resize", handleResize);
    };
  }, [output]);

  return rows;
}

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
  const { stdout } = useStdout();
  const output = useMemo(() => resolveTerminalOutput(stdout), [stdout]);
  const rows = useTerminalRows(output);
  const isInteractiveStdout = useMemo(
    () => enabled && output.isTTY === true,
    [enabled, output],
  );

  useInsertionEffect(() => {
    if (!isInteractiveStdout || typeof output.write !== "function") {
      return;
    }

    output.write(
      ENTER_ALT_SCREEN
      + CLEAR_AND_HOME
      + (mouseTracking ? ENABLE_MOUSE_TRACKING : ""),
    );

    return () => {
      output.write?.(
        (mouseTracking ? DISABLE_MOUSE_TRACKING : "")
        + EXIT_ALT_SCREEN,
      );
    };
  }, [isInteractiveStdout, mouseTracking, output]);

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
