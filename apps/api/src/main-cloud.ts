/**
 * Server entry of Moat Cloud (`AUTH_MODE=cloud`): validates the environment (the Cloud module
 * refuses to start half-configured), starts the API and logs the address. Built by
 * `webpack.cloud.config.js` into `dist/apps/cloud-api/main.js`; `nx run api:serve-cloud` builds
 * and starts it for development with `MOAT_DEV=true` (see `cloud-dev-env.ts`).
 *
 * Not yet here: an image, Helm values, serving the dashboard's files — a reverse proxy puts the
 * dashboard and `/api` on one origin (the API refuses cross-site writes, T-78).
 */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devEnvironment } from './cloud-dev-env';

async function main(): Promise<void> {
  const { values } = devEnvironment(
    process.env,
    () => join(tmpdir(), `moat-cloud-dev-${randomBytes(6).toString('hex')}`),
    () => randomBytes(32).toString('base64url'),
  );
  Object.assign(process.env, values);
  // After the environment is complete: the Cloud module validates it when it is imported.
  const { bootstrapCloud } = await import('./bootstrap-cloud');
  const port = Number(process.env['PORT'] ?? '3000');
  const host = process.env['HOST'] ?? '127.0.0.1';
  const running = await bootstrapCloud({
    port,
    host,
    shutdownHooks: true,
    logger: ['error', 'warn', 'log'],
  });
  process.stdout.write(`Moat Cloud API listening on ${host}:${running.port}\n`);
  if (values['MOAT_DATA_DIR'] !== undefined) {
    process.stdout.write(
      `Development data folder: ${values['MOAT_DATA_DIR']}\n`,
    );
  }
}

main().catch((error: unknown) => {
  // The message names the variable, never a value (validateEnv).
  process.stderr.write(
    `Moat Cloud did not start: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});
