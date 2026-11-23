/**
 * Names that mark a path as holding secrets wherever they appear in it: what a
 * remote Agent, a sandboxed Skill and a network client reading the workspace
 * may not open.
 */
export const SECRET_DIRECTORIES: ReadonlySet<string> = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kodax', '.agents', '.codex', '.claude', '.gemini',
  '.direnv', '.terraform.d',
]);

export const SECRET_FILES: ReadonlySet<string> = new Set([
  '.env', '.envrc', '.pgpass', '.npmrc', '.pypirc', 'credentials', 'id_rsa', 'id_ed25519',
]);

/** Whether a path relative to some root names a secret by any of its parts. Either separator splits it. */
export function isSecretPath(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) => {
    const name = part.toLowerCase();
    return SECRET_DIRECTORIES.has(name) || SECRET_FILES.has(name) || name.startsWith('.env.');
  });
}
