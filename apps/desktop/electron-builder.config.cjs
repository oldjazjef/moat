// electron-builder configuration for Moat Desktop (as lazy-koins). Packages the folder that
// apps/desktop/scripts/stage.mjs assembled (`--projectDir dist/apps/desktop-app`) into
// dist/desktop: Windows NSIS (x64), macOS dmg (arm64 + x64), Linux AppImage.
//
// Signing and auto-update: none yet — an open decision (CLAUDE.md, "Open decisions"). Without
// CSC_LINK the macOS identity is forced off; there is no `publish` provider.
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const electronVersion = require(
  path.join(repoRoot, 'node_modules/electron/package.json'),
).version;
const signing = Boolean(process.env.CSC_LINK);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ch.moat.desktop',
  productName: 'Moat',
  copyright: 'Moat',
  electronVersion,
  directories: {
    output: path.join(repoRoot, 'dist/desktop'),
    buildResources: path.join(repoRoot, 'apps/desktop/build'),
  },
  files: [
    'package.json',
    'main.js',
    'preload.js',
    'api/**',
    'web/**',
    'node_modules/**',
    '!**/*.map',
    '!pnpm-workspace.yaml',
    '!pnpm-lock.yaml',
    '!.deps-hash',
  ],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  publish: null,
  // No running the binary as plain Node, no NODE_OPTIONS, no --inspect, and only the checked
  // app.asar: otherwise any local process could run code under Moat's identity (and later its
  // keychain entries, DT-04). `file://` gets no extra privileges; the app uses app:// only.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    resetAdHocDarwinSignature: !signing,
  },
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName}-Setup-${version}.${ext}',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.developer-tools',
    ...(signing ? {} : { identity: null }),
  },
  linux: { target: [{ target: 'AppImage', arch: ['x64'] }] },
};
