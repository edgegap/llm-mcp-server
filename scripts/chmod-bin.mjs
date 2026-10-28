// Marks the two entry points executable after tsc. A script rather than
// `chmod` so the build also runs under cmd.exe on Windows, where the mode
// bits mean nothing and this does nothing harmful.
import { chmodSync } from 'node:fs';

for (const f of ['dist/index.js', 'dist/http.js']) chmodSync(f, 0o755);
