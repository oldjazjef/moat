/**
 * The environment the in-process API boots with (validated by apps/api/src/config/env.ts).
 * `AUTH_MODE=local` + `LOCAL_MODE=true`: one local user, no sign-in, and the API binds 127.0.0.1
 * only. Without an open project MOAT_PROJECT_DIR is left out, and an inherited value is removed.
 */
export function desktopApiEnv(projectDir: string | null): {
  set: Record<string, string>;
  unset: readonly string[];
} {
  const set: Record<string, string> = {
    NODE_ENV: 'production',
    AUTH_MODE: 'local',
    LOCAL_MODE: 'true',
  };
  if (projectDir !== null) set['MOAT_PROJECT_DIR'] = projectDir;
  return { set, unset: projectDir === null ? ['MOAT_PROJECT_DIR'] : [] };
}
