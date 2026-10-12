/**
 * Entry point of the API bundle Moat Desktop loads in-process (`webpack.config.js` →
 * `dist/apps/desktop-api/main.js`, a CommonJS library), as lazy-koins. It starts nothing on
 * import: the Electron main process sets the environment (AUTH_MODE=local, LOCAL_MODE=true,
 * MOAT_PROJECT_DIR), then `require`s this file and calls `bootstrap({ port: 0, accessToken })`.
 */
export {
  bootstrap,
  type BootstrapOptions,
  DESKTOP_ACCESS_HEADER,
  type RunningApi,
} from './bootstrap';
