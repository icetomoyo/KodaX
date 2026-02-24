/**
 * KodaX Bash Tool
 *
 * 命令执行工具
 */

import { spawn } from 'child_process';
import iconv from 'iconv-lite';
import { KODAX_DEFAULT_TIMEOUT, KODAX_HARD_TIMEOUT } from '../constants.js';

export async function toolBash(input: Record<string, unknown>): Promise<string> {
  const command = input.command as string;
  const userTimeout = input.timeout as number | undefined;
  const timeout = userTimeout ? Math.min(KODAX_HARD_TIMEOUT, userTimeout) : KODAX_DEFAULT_TIMEOUT;
  const capped = userTimeout && userTimeout > KODAX_HARD_TIMEOUT;

  return new Promise(resolve => {
    const proc = spawn(command, [], { shell: true, windowsHide: true, cwd: process.cwd() });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const timer = setTimeout(() => {
      proc.kill();
      const partial = stdout.length ? stdout.toString('utf-8').slice(0, 2000) : '';
      resolve(`[Timeout] Command interrupted after ${timeout}s\n\nPartial output:\n${partial}\n\n[Suggestion] The command took too long. Consider:\n- Is this a watch/dev server? Run in a separate terminal.\n- Can the task be broken into smaller steps?\n- Is there an error causing it to hang?`);
    }, timeout * 1000);

    proc.stdout?.on('data', (d: Buffer) => { stdout = Buffer.concat([stdout, d]); });
    proc.stderr?.on('data', (d: Buffer) => { stderr = Buffer.concat([stderr, d]); });
    proc.on('close', code => {
      clearTimeout(timer);
      const decode = (b: Buffer) => {
        if (process.platform === 'win32') {
          try { const s = b.toString('utf-8'); if (!/[\uFFFD]/.test(s)) return s; } catch { }
          return iconv.decode(b, 'gbk');
        }
        return b.toString('utf-8');
      };
      let out = `Exit: ${code}\n${decode(stdout)}`;
      if (stderr.length) out += `\n[stderr]\n${decode(stderr)}`;
      if (capped) out += `\n[Note] Timeout capped at ${KODAX_HARD_TIMEOUT}s`;
      resolve(out);
    });
    proc.on('error', e => { clearTimeout(timer); resolve(`[Error] ${e.message}`); });
  });
}
