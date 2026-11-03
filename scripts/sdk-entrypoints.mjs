/** Package exports own the JS/type build inventory; source names follow the SDK convention. */
export function sdkEntriesFromPackage(pkg) {
  const entries = {};
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath === './package.json' && target === './package.json') continue;
    // Artifacts is built and staged as an independent package, outside the root SDK bundle.
    if (/^\.\/artifacts(?:\/|$)/.test(subpath)
      && /^\.\/dist\/artifacts\/dist\/[a-z-]+\.js$/.test(target?.import)
      && target.types === target.import.replace(/\.js$/, '.d.ts')) continue;
    const name = /^\.\/dist\/([a-z][a-z0-9-]*)\.js$/.exec(target?.import)?.[1];
    if (!name || target.types !== `./dist/${name}.d.ts` || name in entries) {
      throw new Error(`Invalid or duplicate SDK export: ${subpath}`);
    }
    entries[name] = `src/${name === 'sdk-runtime' ? 'sdk-runtime-public' : name}.ts`;
  }
  return entries;
}
