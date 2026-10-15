#!/usr/bin/env node
/**
 * Runs apps/desktop/e2e/passkey.e2e.ts in Electron: the passkey windows against the real
 * in-process API, with a Chromium virtual authenticator as the passkey (never a real one).
 *
 *   pnpm exec nx run api:build
 *   xvfb-run -a node apps/desktop/scripts/passkey-e2e.mjs
 *
 * On a headless machine as root, Electron needs `--no-sandbox` (added here; never in a shipped
 * build). Exits non-zero when a check fails.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const require = createRequire(import.meta.url);
const apiDist = path.join(repoRoot, 'dist/apps/desktop-api');
if (!existsSync(path.join(apiDist, 'main.js')))
  throw new Error('Missing the API bundle: run `pnpm exec nx run api:build`');

const out = path.join(tmpdir(), `moat-passkey-e2e-${process.pid}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: {
    main: path.join(repoRoot, 'apps/desktop/e2e/passkey.e2e.ts'),
    'passkey-preload': path.join(
      repoRoot,
      'apps/desktop/src/preload/passkey-preload.ts',
    ),
    'passkey-sign-preload': path.join(
      repoRoot,
      'apps/desktop/src/preload/passkey-sign-preload.ts',
    ),
  },
  outdir: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(repoRoot, 'tsconfig.base.json'),
  logLevel: 'warning',
});
cpSync(
  path.join(repoRoot, 'apps/desktop/src/dialogs'),
  path.join(out, 'dialogs'),
  { recursive: true },
);
// api-host loads <appDir>/api/main.js; a link keeps its dependencies resolvable from the repo.
symlinkSync(apiDist, path.join(out, 'api'), 'dir');

const electron = require('electron');
const run = spawnSync(electron, ['--no-sandbox', path.join(out, 'main.js')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MOAT_E2E_APP_DIR: out,
    MOAT_E2E_RECIPE: path.join(
      repoRoot,
      'recipes/hubspot-newsletter.moat.yaml',
    ),
  },
});
rmSync(out, { recursive: true, force: true });
console.log('electron exit', run.status, run.signal);
process.exit(run.status ?? 1);
