#!/usr/bin/env node
// Bundles the CLI into one file (CLAUDE.md, CLI): dist/apps/cli/moat.cjs. Reproducible — no
// timestamps, no absolute paths, legal comments kept in a separate file.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  alias: { '@moat/core': path.join(root, 'libs/core/src/index.ts') },
  legalComments: 'external',
  sourcemap: false,
  logLevel: 'warning',
});
