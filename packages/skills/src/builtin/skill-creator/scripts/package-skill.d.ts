export interface PackagedSkillFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SkillPackageManifest {
  format: 'kodax-skill-package';
  version: 1;
  created_at: string;
  entrypoint: 'SKILL.md';
  skill: {
    name: string;
    description: string;
    compatibility: string | null;
    user_invocable: boolean;
    disable_model_invocation: boolean;
  };
  files: PackagedSkillFile[];
  note: string;
}

export function createPackageManifest(
  skill: { frontmatter: Record<string, unknown> },
  files: Array<{ relativePath: string; bytes: Uint8Array; sha256: string }>,
  options?: { createdAt?: string }
): SkillPackageManifest;

export function buildSkillPackage(
  skillDir: string,
  options?: { createdAt?: string }
): Promise<{ manifest: SkillPackageManifest; bytes: Uint8Array }>;

export function writeSkillPackage(
  skillDir: string,
  outputPath: string,
  options?: { createdAt?: string }
): Promise<{ manifest: SkillPackageManifest; bytes: Uint8Array; outputPath: string }>;
