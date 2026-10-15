/**
 * Server entry of Moat Cloud (`AUTH_MODE=cloud`), built by `webpack.cloud.config.js` into
 * `dist/apps/cloud-api/main.js`:
 *
 * - production (the image, `NODE_ENV=production`): the environment comes from the variables (or
 *   `…_FILE` secret files), `validateEnv` refuses a half-configured Cloud, the database is
 *   migrated on start, the API and the dashboard's files are served from the one origin
 *   `MOAT_PUBLIC_ORIGIN`, `SIGTERM`/`SIGINT` end it gracefully;
 * - `nx run api:serve-cloud` sets `MOAT_DEV=true` and gets the development conveniences of
 *   `cloud-dev-env.ts` (temporary SQLite, random account key, no dashboard files). `MOAT_DEV` next
 *   to `NODE_ENV=production` is refused, and without `MOAT_DEV` anything but `NODE_ENV=production`
 *   is refused too.
 *
 * TLS is the reverse proxy's job (deploy/compose/README.md): this process speaks HTTP.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devEnvironment } from './cloud-dev-env';
import {
  assertRunMode,
  resolveSecretFiles,
  serverSettings,
} from './cloud-server/server-settings';

/** A running request gets this long after the signal; then the process ends anyway (ms). */
const HARD_EXIT_MS = 15_000;

async function main(): Promise<void> {
  const { values } = devEnvironment(
    process.env,
    () => join(tmpdir(), `moat-cloud-dev-${randomBytes(6).toString('hex')}`),
    () => randomBytes(32).toString('base64url'),
  );
  Object.assign(process.env, values);
  assertRunMode(process.env);
  Object.assign(
    process.env,
    resolveSecretFiles(process.env, (path) => readFileSync(path, 'utf8')),
  );
  const settings = serverSettings(process.env);
  // After the environment is complete: the Cloud module validates it when it is imported.
  const { bootstrapCloud } = await import('./bootstrap-cloud');
  const running = await bootstrapCloud({
    port: settings.port,
    host: settings.host,
    ...(settings.webDir === undefined ? {} : { webDir: settings.webDir }),
    logger: ['error', 'warn', 'log'],
  });
  process.stdout.write(
    `Moat Cloud listening on ${settings.host}:${running.port}\n`,
  );
  if (values['MOAT_DATA_DIR'] !== undefined) {
    process.stdout.write(
      `Development data folder: ${values['MOAT_DATA_DIR']}\n`,
    );
  }
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${signal}: shutting down\n`);
    setTimeout(() => process.exit(1), HARD_EXIT_MS).unref();
    running.shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  // The message names the variable, never a value (validateEnv, server-settings).
  process.stderr.write(
    `Moat Cloud did not start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
