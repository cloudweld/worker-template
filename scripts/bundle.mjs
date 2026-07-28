#!/usr/bin/env node
/**
 * Bundle the multi-file Worker template into a single ESM file that the
 * backend can upload to a customer's Cloudflare account via the multipart
 * script-upload API (which takes one module, not a source tree).
 *
 * Writes two copies:
 *   packages/worker-template/dist/          — local artifact, gitignored
 *   backend/src/assets/worker-bundle/       — COMMITTED, shipped in the
 *                                             backend Docker image
 *
 * The backend's Docker build context is ./backend only, so it cannot reach
 * packages/. Committing the bundle is what makes the artifact reachable at
 * runtime. `bundleParity.test.mjs` re-runs this build and fails if the
 * committed copy has drifted from src/, so the duplication can't rot.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PKG_ROOT, '../..');

const ENTRY = resolve(PKG_ROOT, 'src/index.js');
const OUT_DIRS = [
  resolve(PKG_ROOT, 'dist'),
  resolve(REPO_ROOT, 'backend/src/assets/worker-bundle'),
];

/** Read compatibility_date out of wrangler.toml so the two can't drift. */
async function readCompatibilityDate() {
  const toml = await readFile(resolve(PKG_ROOT, 'wrangler.toml'), 'utf8');
  const m = toml.match(/^\s*compatibility_date\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error('compatibility_date not found in wrangler.toml');
  return m[1];
}

/** Read TEMPLATE_VERSION out of the worker source (single source of truth). */
async function readTemplateVersion() {
  const src = await readFile(ENTRY, 'utf8');
  const m = src.match(/const\s+TEMPLATE_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('TEMPLATE_VERSION not found in src/index.js');
  return m[1];
}

export async function bundleWorker() {
  const [compatibilityDate, templateVersion] = await Promise.all([
    readCompatibilityDate(),
    readTemplateVersion(),
  ]);

  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    // Workers runtime provides these; never polyfill.
    external: ['cloudflare:*', 'node:*'],
    minify: false, // readable in `wrangler tail` / CF dashboard
    write: false,
    legalComments: 'none',
  });

  const code = result.outputFiles[0].text;
  const sha256 = createHash('sha256').update(code).digest('hex');
  const meta = { templateVersion, compatibilityDate, sha256, bytes: code.length };

  return { code, meta };
}

async function main() {
  const { code, meta } = await bundleWorker();
  for (const dir of OUT_DIRS) {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'worker.bundle.js'), code, 'utf8');
    await writeFile(resolve(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }
  console.log(
    `bundled worker v${meta.templateVersion} (${meta.bytes} bytes, compat ${meta.compatibilityDate})`
  );
  for (const d of OUT_DIRS) console.log(`  → ${d}/worker.bundle.js`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
