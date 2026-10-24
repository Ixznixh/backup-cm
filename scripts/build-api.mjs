/**
 * Bundles the Express API into a single ESM file at `api/index.js`, which is what Vercel
 * packages as the serverless function.
 *
 * Why bundle: Vercel transpiles TypeScript files individually and then runs them as native
 * ESM. The server tree uses extensionless relative imports (`./routes/home`), which TypeScript
 * resolves but native ESM does not, so an unbundled function dies at startup with
 * `Cannot find module '/var/task/server/index'`.
 *
 * Dependencies stay external (`packages: 'external'`) so Vercel's file tracing installs and
 * ships the real node_modules instead of a hand-inlined express/youtubei.js bundle.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'server/api-entry.ts')],
  outfile: path.join(root, 'api/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'warning',
});

console.log('[build-api] wrote api/index.js');
