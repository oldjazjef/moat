// The Moat Cloud server (`src/main-cloud.ts`) as a plain Node script → dist/apps/cloud-api/main.js.
// Same module rules as the desktop library: the migrations' SQL is bundled as text.
const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { join } = require('path');

module.exports = {
  output: {
    path: join(__dirname, '../../dist/apps/cloud-api'),
    clean: true,
  },
  module: {
    rules: [{ resourceQuery: /raw/, type: 'asset/source' }],
  },
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main-cloud.ts',
      tsConfig: './tsconfig.app.json',
      assets: [],
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: false,
      sourceMap: true,
    }),
  ],
};
