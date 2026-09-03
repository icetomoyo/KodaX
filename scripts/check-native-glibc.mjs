import { readFileSync } from 'node:fs';
import path from 'node:path';

function parseVersion(value) {
  if (!/^\d+(?:\.\d+)+$/.test(value)) {
    throw new Error(`Invalid glibc version: ${value}`);
  }
  return value.split('.').map(Number);
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requiredGlibcVersions(artifact) {
  const bytes = readFileSync(artifact);
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`${artifact} is not an ELF artifact`);
  }
  const versions = new Set();
  for (const match of bytes.toString('latin1').matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)) {
    versions.add(match[1]);
  }
  if (versions.size === 0) {
    throw new Error(`${artifact} has no GLIBC symbol versions`);
  }
  return [...versions].sort((left, right) => compareVersions(
    parseVersion(left),
    parseVersion(right),
  ));
}

function parseArguments(args) {
  if (args.length < 3 || args[0] !== '--max') {
    throw new Error('Usage: node scripts/check-native-glibc.mjs --max <version> <artifact...>');
  }
  return { maximum: args[1], artifacts: args.slice(2) };
}

function main() {
  const { maximum, artifacts } = parseArguments(process.argv.slice(2));
  const maximumParts = parseVersion(maximum);
  for (const artifact of artifacts) {
    const versions = requiredGlibcVersions(artifact);
    const required = versions.at(-1);
    if (compareVersions(parseVersion(required), maximumParts) > 0) {
      throw new Error(
        `${artifact} requires GLIBC_${required}; maximum supported is GLIBC_${maximum}`,
      );
    }
    process.stdout.write(
      `[check-native-glibc] ${path.normalize(artifact)} maximum required GLIBC_${required}\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[check-native-glibc] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
