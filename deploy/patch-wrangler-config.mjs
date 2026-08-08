// Produce packages/worker/wrangler.generated.jsonc from the template:
//   node patch-wrangler-config.mjs <d1_database_id> [--no-routes]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '../packages/worker/wrangler.jsonc');
const dst = path.join(here, '../packages/worker/wrangler.generated.jsonc');

const [dbId, flag] = process.argv.slice(2);
if (!dbId) { console.error('usage: patch-wrangler-config.mjs <d1_id> [--no-routes]'); process.exit(1); }

let text = fs.readFileSync(src, 'utf8').replace('__D1_DATABASE_ID__', dbId);
if (flag === '--no-routes') {
  text = text.replace(/"routes":\s*\[[^\]]*\],/s, '"workers_dev": true,');
}
fs.writeFileSync(dst, text);
console.log('wrote', dst);
