import type { SkillPackageManifest } from './package-skill.js';

export interface InstalledSkillResult {
  skillName: string;
  installedTo: string;
  source: string;
  manifest: SkillPackageManifest | null;
}

export function readSkillPackageBuffer(buffer: Uint8Array): {
  skillName: string;
  manifest: SkillPackageManifest | null;
  entries: Array<{ relativePath: string; bytes: Uint8Array }>;
};

export function installSkillArchive(
  archivePath: string,
  options?: { skillsDir?: string; force?: boolean }
): Promise<InstalledSkillResult>;

export function installSkillDirectory(
  skillDir: string,
  options?: { skillsDir?: string; force?: boolean }
): Promise<InstalledSkillResult>;

export function installSkill(
  inputPath: string,
  options?: { skillsDir?: string; force?: boolean }
): Promise<InstalledSkillResult>;
