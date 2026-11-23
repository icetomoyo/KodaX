import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Read the CLI version from the binary build define first, then package.json.
const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../package.json',
);
export const version =
  process.env.KODAX_VERSION ??
  (fsSync.existsSync(packageJsonPath)
    ? JSON.parse(fsSync.readFileSync(packageJsonPath, 'utf-8')).version
    : '0.0.0');
