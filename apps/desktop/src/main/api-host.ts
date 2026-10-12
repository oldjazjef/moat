import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { desktopApiEnv } from './lib/api-env';

/** What `dist/apps/desktop-api/main.js` (apps/api/src/desktop.ts) exports. */
interface ApiBundle {
  DESKTOP_ACCESS_HEADER: string;
  bootstrap(options: {
    port: number;
    accessToken: string;
    logger?: string[] | false;
  }): Promise<{
    app: { close(): Promise<void> };
    port: number;
    host: string;
  }>;
}

export interface RunningApi {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  accessHeader: string;
  accessToken: string;
  close(): Promise<void>;
}

/**
 * Starts the NestJS API in this process, on 127.0.0.1 and a port the OS picks (as lazy-koins).
 * Called once per process: the API's ConfigModule reads the environment when its bundle is
 * loaded, so another project folder means a relaunch (see main.ts), not a restart.
 */
export async function startApi(options: {
  appDir: string;
  projectDir: string | null;
}): Promise<RunningApi> {
  const env = desktopApiEnv(options.projectDir);
  for (const name of env.unset) delete process.env[name];
  Object.assign(process.env, env.set);

  // Loaded only now: its ConfigModule validates process.env at load time.
  const api = require(join(options.appDir, 'api', 'main.js')) as ApiBundle;
  // Per launch, known only to this process and the API (CLAUDE.md, Desktop).
  const accessToken = randomBytes(32).toString('hex');
  const running = await api.bootstrap({
    port: 0,
    accessToken,
    logger: ['error', 'warn'],
  });
  return {
    baseUrl: `http://127.0.0.1:${running.port}`,
    accessHeader: api.DESKTOP_ACCESS_HEADER,
    accessToken,
    close: () => running.app.close(),
  };
}
