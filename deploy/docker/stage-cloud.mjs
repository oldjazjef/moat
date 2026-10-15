#!/usr/bin/env node
/**
 * Stages what the Moat Cloud image runs (deploy/docker/Dockerfile, build stage):
 *
 *   <out>/main.js            the server (dist/apps/cloud-api/main.js, no source map)
 *   <out>/web/               the dashboard (dist/apps/web-cloud/browser)
 *   <out>/package.json       the server's runtime dependencies, exact versions from the build
 *   <out>/pnpm-workspace.yaml
 *
 * The server is a webpack bundle of our code with its npm packages left external; Nx lists those
 * in dist/apps/cloud-api/package.json but misses some (`@prisma/client`, `tslib`); every package
 * the bundle requires is checked here and added with the repository's version. Usage:
 * `node deploy/docker/stage-cloud.mjs <out>` from the repository root, after the two builds.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const out = process.argv[2];
if (out === undefined) {
  console.error('usage: node deploy/docker/stage-cloud.mjs <out>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '../..');
const api = join(root, 'dist/apps/cloud-api');
const web = join(root, 'dist/apps/web-cloud/browser');
for (const needed of [
  join(api, 'main.js'),
  join(api, 'package.json'),
  join(web, 'index.html'),
]) {
  if (!existsSync(needed)) {
    console.error(`stage-cloud: ${needed} is missing; run the builds first`);
    process.exit(1);
  }
}

const rootManifest = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
const apiManifest = JSON.parse(readFileSync(join(api, 'package.json'), 'utf8'));
const dependencies = { ...apiManifest.dependencies };
// Every package the bundle requires at run time must be installed: Nx misses some (`@prisma/client`
// through a sub-path, `tslib`). The version comes from the repository's package.json; a package
// declared in neither is an error, never a guess.
const bundle = readFileSync(join(api, 'main.js'), 'utf8');
const required = new Set();
for (const match of bundle.matchAll(/require\("([^".\/][^"]*)"\)/g)) {
  const specifier = match[1];
  if (specifier.startsWith('node:')) continue;
  const parts = specifier.split('/');
  required.add(
    specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0],
  );
}
for (const name of required) {
  if (dependencies[name] !== undefined) continue;
  const version =
    rootManifest.dependencies?.[name] ?? rootManifest.devDependencies?.[name];
  if (typeof version !== 'string') {
    console.error(
      `stage-cloud: the server requires ${name}, which the repository does not declare`,
    );
    process.exit(1);
  }
  dependencies[name] = version;
}

const target = resolve(out);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
copyFileSync(join(api, 'main.js'), join(target, 'main.js'));
// Never `env.js` of the build: the server generates its own (static-site.ts).
cpSync(web, join(target, 'web'), {
  recursive: true,
  filter: (source) => !source.endsWith('/env.js'),
});
writeFileSync(
  join(target, 'package.json'),
  `${JSON.stringify(
    {
      name: 'moat-cloud',
      private: true,
      license: 'MIT',
      main: 'main.js',
      dependencies: Object.fromEntries(
        Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
      ),
      packageManager: rootManifest.packageManager,
    },
    null,
    2,
  )}\n`,
);
// Its own pnpm workspace root, so pnpm does not walk up into a parent workspace.
writeFileSync(
  join(target, 'pnpm-workspace.yaml'),
  [
    'packageImportMethod: copy',
    'allowBuilds:',
    "  '@nestjs/core': false",
    '',
  ].join('\n'),
);
console.log(`stage-cloud: ${target} ready`);
