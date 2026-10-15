import { clientSecrets } from '../http/client';

interface SecretUser {
  readonly upstreams: Readonly<
    Record<string, { readonly auth?: { readonly secret: string } | null }>
  >;
  readonly routes: Readonly<
    Record<
      string,
      {
        readonly client?: Parameters<typeof clientSecrets>[0];
      }
    >
  >;
}

/**
 * Every secret a config uses, sorted: the upstreams' sign-in (FR-20) and the routes' client
 * checks (FR-16, API key and Turnstile). What a bundle of this config must carry.
 */
export function usedSecrets(config: SecretUser): string[] {
  const names = new Set<string>();
  for (const upstream of Object.values(config.upstreams))
    if (upstream.auth) names.add(upstream.auth.secret);
  for (const route of Object.values(config.routes))
    for (const name of clientSecrets(route.client)) names.add(name);
  return [...names].sort();
}
