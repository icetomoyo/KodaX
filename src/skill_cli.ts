import path from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { getDefaultSkillPaths } from '@kodax/skills';

export const SKILL_CREATOR_TOOLS = {
  validate: 'quick-validate.js',
  package: 'package-skill.js',
  install: 'install-skill.js',
} as const;

export type SkillCreatorToolAction = keyof typeof SKILL_CREATOR_TOOLS;

export function resolveSkillCreatorToolPath(
  action: SkillCreatorToolAction,
  builtinPath: string = getDefaultSkillPaths().builtinPath
): string {
  return path.join(
    builtinPath,
    'skill-creator',
    'scripts',
    SKILL_CREATOR_TOOLS[action]
  );
}

export async function defaultSkillToolRunner(
  scriptPath: string,
  args: string[]
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

export async function runSkillCreatorTool(
  action: SkillCreatorToolAction,
  args: string[],
  runner: (scriptPath: string, args: string[]) => Promise<number> = defaultSkillToolRunner
): Promise<void> {
  const scriptPath = resolveSkillCreatorToolPath(action);
  const exitCode = await runner(scriptPath, args);
  if (exitCode !== 0) {
    throw new Error(`skill ${action} failed with exit code ${exitCode}`);
  }
}

export function toFileUrl(filePath: string): string {
  return pathToFileURL(filePath).href;
}
