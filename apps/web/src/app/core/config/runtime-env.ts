/**
 * Runtime configuration, read from `public/env.js` rather than baked into the bundle (as
 * lazy-koins): one build serves every environment. Moat Desktop generates its own env.js.
 */

/** `local` = Moat Desktop: no sign-in, the API acts for its one local user (`AUTH_MODE=local`). */
export type AuthMode = 'local';

export interface RuntimeEnv {
  /** Base URL of the API, without `/api`. Empty = same origin (the desktop's app:// proxy). */
  apiBaseUrl: string;
  authMode: AuthMode;
}

const DEFAULTS: RuntimeEnv = { apiBaseUrl: '', authMode: 'local' };

declare global {
  interface Window {
    __MT_ENV__?: Partial<RuntimeEnv>;
  }
}

export function runtimeEnv(): RuntimeEnv {
  const provided = window.__MT_ENV__ ?? {};
  const base =
    typeof provided.apiBaseUrl === 'string' ? provided.apiBaseUrl.trim() : '';
  return {
    apiBaseUrl: (base || DEFAULTS.apiBaseUrl).replace(/\/+$/, ''),
    authMode: DEFAULTS.authMode,
  };
}

/** The URL of an API path (`/project` → `<base>/api/project`). */
export function apiUrl(path: string): string {
  return `${runtimeEnv().apiBaseUrl}/api${path}`;
}
