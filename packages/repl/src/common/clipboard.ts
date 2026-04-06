import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import process from "node:process";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

export interface ClipboardWriteOptions {
  terminalWrite?: (chunk: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ClipboardWriteResult {
  path: "native" | "tmux-buffer" | "osc52";
}

function shouldPreferNativeClipboard(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  if (env.SSH_CONNECTION) {
    return false;
  }

  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function buildOscSequence(
  text: string,
  env: NodeJS.ProcessEnv,
): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  const terminator = env.TERM === "xterm-kitty" ? ST : BEL;
  const raw = `${ESC}]52;c;${base64}${terminator}`;

  if (env.TMUX) {
    return `${ESC}Ptmux;${raw.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`;
  }

  if (env.STY) {
    return `${ESC}P${raw}${ST}`;
  }

  return raw;
}

async function execClipboardCommand(
  command: string,
  args: string[],
  input: string | Buffer,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";

    child.on("error", reject);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
    });

    child.stdin?.write(input);
    child.stdin?.end();
  });
}

function buildWindowsClipboardCandidates(
  text: string,
): Array<[string, string[], string | Buffer]> {
  const script =
    "$stream = [Console]::OpenStandardInput(); " +
    "$buffer = New-Object byte[] 8192; " +
    "$memory = New-Object System.IO.MemoryStream; " +
    "while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $memory.Write($buffer, 0, $read) }; " +
    "$text = [System.Text.Encoding]::UTF8.GetString($memory.ToArray()); " +
    "Set-Clipboard -Value $text";
  const utf8Input = Buffer.from(text, "utf8");

  return [
    ["powershell", ["-NoProfile", "-NonInteractive", "-Command", script], utf8Input],
    ["pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], utf8Input],
    ["clip", [], text],
  ];
}

async function tryNativeClipboard(
  text: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (env.SSH_CONNECTION) {
    return false;
  }

  switch (platform) {
    case "win32": {
      const candidates = buildWindowsClipboardCandidates(text);

      for (const [command, args, input] of candidates) {
        try {
          const success = await execClipboardCommand(command, args, input);
          if (success) {
            return true;
          }
        } catch {
          // Try the next candidate.
        }
      }

      return false;
    }
    case "darwin":
      return execClipboardCommand("pbcopy", [], text);
    case "linux": {
      const candidates: Array<[string, string[]]> = [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];

      for (const [command, args] of candidates) {
        try {
          const success = await execClipboardCommand(command, args, text);
          if (success) {
            return true;
          }
        } catch {
          // Try the next candidate.
        }
      }
      return false;
    }
    default:
      return false;
  }
}

async function tryTmuxClipboard(
  text: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!env.TMUX) {
    return false;
  }

  const args =
    env.LC_TERMINAL === "iTerm2"
      ? ["load-buffer", "-"]
      : ["load-buffer", "-w", "-"];

  try {
    return await execClipboardCommand("tmux", args, text);
  } catch {
    return false;
  }
}

export async function copyTextToClipboard(
  text: string,
  options: ClipboardWriteOptions = {},
): Promise<ClipboardWriteResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const value = text.trimEnd();
  const oscSequence = buildOscSequence(value, env);

  if (!value) {
    throw new Error("Nothing to copy.");
  }

  if (shouldPreferNativeClipboard(env, platform)) {
    try {
      if (await tryNativeClipboard(value, env, platform)) {
        return { path: "native" };
      }
    } catch {
      // Fall through to tmux / OSC 52 paths.
    }
  }

  if (await tryTmuxClipboard(value, env)) {
    return { path: "tmux-buffer" };
  }

  if (options.terminalWrite?.(oscSequence)) {
    return { path: "osc52" };
  }

  if (!shouldPreferNativeClipboard(env, platform)) {
    try {
      if (await tryNativeClipboard(value, env, platform)) {
        return { path: "native" };
      }
    } catch {
      // Fall through to the final error path.
    }
  }

  throw new Error("Unable to access any clipboard path.");
}
