// The API as a CommonJS library for Moat Desktop (apps/desktop), as lazy-koins'
// webpack.desktop.config.js: `src/desktop.ts` exports `bootstrap()` and starts nothing on import.
const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/desktop-api'),
    clean: true,
    // `module.exports = { bootstrap, … }` instead of a script with no exports.
    library: { type: 'commonjs2' },
  },
  module: {
    // The migrations' SQL (persistence/database/migrations.ts) as text, so the desktop applies
    // them without the Prisma CLI.
    rules: [{ resourceQuery: /raw/, type: 'asset/source' }],
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      // Emitted as main.js: Nx names the entry `main`.
      main: './src/desktop.ts',
      tsConfig: './tsconfig.app.json',
      assets: [],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
      sourceMap: true,
    }),
  ],
};
