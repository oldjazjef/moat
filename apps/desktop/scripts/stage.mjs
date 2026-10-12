#!/usr/bin/env node
/**
 * Assembles the Electron app folder `dist/apps/desktop-app` — what `electron` runs in dev
 * (`pnpm start:desktop`) and what electron-builder packages (as lazy-koins):
 *
 *   main.js, preload.js   the main process + preload, bundled here with esbuild
 *   sign-preload.js,      the signing (DT-15) and seal dialogs: their preloads and static pages
 *   seal-preload.js, dialogs/
 *   api/main.js           the NestJS API as a library (`nx run api:build`)
 *   web/                  the Angular build (`nx run web:build:desktop`), served via app://
 *   package.json          name/version/main + the API's runtime dependencies
 *   node_modules/         `pnpm install --prod` — OUTSIDE the workspace's node_modules
 *
 * No native modules yet, so nothing is rebuilt for Electron's ABI.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const out = path.join(repoRoot, 'dist/apps/desktop-app');
const apiDist = path.join(repoRoot, 'dist/apps/desktop-api');
const webDist = path.join(repoRoot, 'dist/apps/web-desktop/browser');
const require = createRequire(import.meta.url);

for (const [what, file] of [
  ['API bundle (nx run api:build)', path.join(apiDist, 'main.js')],
  ['web build (nx run web:build:desktop)', path.join(webDist, 'index.html')],
]) {
  if (!existsSync(file)) throw new Error(`Missing ${what}: ${file}`);
}

// --- fresh folder, but keep node_modules when the dependencies did not change ---
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) {
  if (entry !== 'node_modules' && entry !== '.deps-hash') {
    rmSync(path.join(out, entry), { recursive: true, force: true });
  }
}

// --- main + preload ---
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: {
    // entry.ts installs the fatal-error dialog, then loads main.ts.
    main: path.join(repoRoot, 'apps/desktop/src/main/entry.ts'),
    preload: path.join(repoRoot, 'apps/desktop/src/preload/preload.ts'),
    'sign-preload': path.join(
      repoRoot,
      'apps/desktop/src/preload/sign-preload.ts',
    ),
    'seal-preload': path.join(
      repoRoot,
      'apps/desktop/src/preload/seal-preload.ts',
    ),
  },
  outdir: out,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
});

// --- the dialogs' pages (no script: their preloads render them) ---
cpSync(
  path.join(repoRoot, 'apps/desktop/src/dialogs'),
  path.join(out, 'dialogs'),
  { recursive: true },
);

// --- API, web ---
cpSync(apiDist, path.join(out, 'api'), {
  recursive: true,
  filter: (src) =>
    !/package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$/.test(src),
});
cpSync(webDist, path.join(out, 'web'), { recursive: true });
// The protocol handler generates env.js (authMode 'local'); the dev file must not shadow it.
rmSync(path.join(out, 'web', 'env.js'), { force: true });

// --- package.json ---
const rootManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);
const apiManifest = JSON.parse(
  readFileSync(path.join(apiDist, 'package.json'), 'utf8'),
);
const electronVersion = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'node_modules/electron/package.json'),
    'utf8',
  ),
).version;

// The release workflow sets MOAT_VERSION (X.Y.Z): the app's and the installers' version.
const version = process.env.MOAT_VERSION ?? '0.0.0';
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error(`MOAT_VERSION must look like 1.2.3 (got ${version})`);

const manifest = {
  name: 'moat-desktop',
  productName: 'Moat',
  version,
  description: 'Moat Desktop: API management without a server',
  author: 'Moat',
  license: 'MIT',
  private: true,
  main: 'main.js',
  dependencies: Object.fromEntries(
    Object.entries(apiManifest.dependencies).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  ),
  // Read by electron-builder; never installed (`--prod`).
  devDependencies: { electron: electronVersion },
  packageManager: rootManifest.packageManager,
};
writeFileSync(
  path.join(out, 'package.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// Its own pnpm workspace root, so pnpm does not walk up into the repo's workspace.
const workspaceYaml = [
  'packageImportMethod: copy',
  'allowBuilds:',
  "  '@nestjs/core': false",
  '',
].join('\n');
writeFileSync(path.join(out, 'pnpm-workspace.yaml'), workspaceYaml);

// --- install (skipped when nothing changed) ---
const depsHash = createHash('sha256')
  .update(
    JSON.stringify({
      dependencies: manifest.dependencies,
      workspaceYaml,
      electronVersion,
      arch: process.arch,
    }),
  )
  .digest('hex');
const hashFile = path.join(out, '.deps-hash');
const upToDate =
  existsSync(path.join(out, 'node_modules')) &&
  existsSync(hashFile) &&
  readFileSync(hashFile, 'utf8') === depsHash;

if (upToDate) {
  console.log('stage: dependencies unchanged, node_modules kept');
} else {
  rmSync(path.join(out, 'node_modules'), { recursive: true, force: true });
  rmSync(hashFile, { force: true });
  console.log('stage: installing runtime dependencies (pnpm install --prod)…');
  execFileSync('pnpm', ['install', '--prod', '--no-frozen-lockfile'], {
    cwd: out,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NX_DAEMON: 'false' },
  });
  writeFileSync(hashFile, depsHash);
}

console.log(`stage: ${out} ready (Electron ${electronVersion})`);
