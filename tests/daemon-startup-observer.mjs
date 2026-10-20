import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Observe the real CLI's missing-descriptor lookup without delaying it or
// changing its result. The parent keeps initial A2A discovery pending until
// this marker proves the second start has taken its initial observation.
if (process.argv.includes('start')) {
  const exists = fs.existsSync.bind(fs);
  fs.existsSync = function (file) {
    const result = exists(file);
    if (!result && file === process.env.KODAX_TEST_DAEMON_DESCRIPTOR_FILE) {
      fs.writeFileSync(process.env.KODAX_TEST_DAEMON_DESCRIPTOR_MARKER, 'missing');
    }
    return result;
  };
  syncBuiltinESMExports();
}
