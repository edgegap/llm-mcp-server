// Prints the analytics id (org_...) of one Edgegap API token, the value to add
// to the Worker's TELEMETRY_INTERNAL_IDS so that token's traffic is marked
// is_internal. Same HMAC as worker/telemetry.ts.
//
//   npm run telemetry:id      then paste the TELEMETRY_SALT, Enter, the token, Enter
//
// Both are read from stdin, never from arguments (process arguments are
// visible to other processes and land in shell history). Nothing is sent.
import { createHmac } from 'node:crypto';
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];
for await (const line of rl) {
  if (line.trim()) lines.push(line.trim());
  if (lines.length === 2) break;
}
rl.close();
if (lines.length < 2) {
  console.error('Expected two lines on stdin: the TELEMETRY_SALT, then the API token.');
  process.exit(1);
}
const [salt, raw] = lines;
const token = raw.replace(/^(?:\s*(?:bearer|token)\s+)+/i, '');
console.log(`org_${createHmac('sha256', salt).update(token).digest('hex').slice(0, 32)}`);
