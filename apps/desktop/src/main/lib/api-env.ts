/**
 * The environment the in-process API boots with (validated by apps/api/src/config/env.ts).
 * `AUTH_MODE=local` + `LOCAL_MODE=true`: one local user, no sign-in, and the API binds 127.0.0.1
 * only. `MOAT_DATA_DIR` is the desktop's user-data folder, where the API keeps the project list.
 */
export function desktopApiEnv(dataDir: string): Record<string, string> {
  return {
    NODE_ENV: 'production',
    AUTH_MODE: 'local',
    LOCAL_MODE: 'true',
    MOAT_DATA_DIR: dataDir,
  };
}
