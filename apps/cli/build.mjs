#!/usr/bin/env node
// Bundles the CLI into one file (CLAUDE.md, CLI): dist/apps/cli/moat.cjs. Reproducible — no
// timestamps, no absolute paths, legal comments kept in a separate file.
import { build } from 'esbuild';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The release workflow sets MOAT_VERSION (X.Y.Z) and MOAT_COMMIT; `moat version` prints them.
const version = process.env.MOAT_VERSION ?? '0.0.0-dev';
const commit = process.env.MOAT_COMMIT ?? 'unknown';
if (!/^(\d+\.\d+\.\d+|0\.0\.0-dev)$/.test(version))
  throw new Error(`MOAT_VERSION must look like 1.2.3 (got ${version})`);
if (!/^([0-9a-f]{40}|unknown)$/.test(commit))
  throw new Error(`MOAT_COMMIT must be a full commit hash (got ${commit})`);

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

await build({
  entryPoints: [path.join(root, 'apps/cli/src/main.ts')],
  outfile: path.join(root, 'dist/apps/cli/moat.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
  define: { MOAT_BUILD: JSON.stringify({ version, commit }) },
  alias: { '@moat/core': path.join(root, 'libs/core/src/index.ts') },
  legalComments: 'external',
  sourcemap: false,
  logLevel: 'warning',
});
