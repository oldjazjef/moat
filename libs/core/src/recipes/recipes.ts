import { z } from 'zod';
import {
  ConfigEditError,
  setRoute,
  setUpstream,
  type RouteInput,
  type UpstreamInput,
} from '../config/edit';
import { loadMoatYaml } from '../config/yaml';

/**
 * Recipes (FR-43): ready-made upstream + route pairs for a common use case, as data. Each one is
 * the same as its file in `recipes/` (a spec keeps them equal) and is applied through the
 * comment-preserving edits of config/edit.ts, so a recipe can never write anything the loader
 * refuses. The only parameter is where the website runs (FR-15); everything else is a
 * conservative default the person changes later in «Routen».
 */
export const RECIPE_IDS = ['hubspot-newsletter', 'openai-chat'] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

export interface Recipe {
  readonly id: RecipeId;
  readonly upstream: { readonly name: string; readonly input: UpstreamInput };
  readonly route: { readonly name: string; readonly input: RouteInput };
  /** The secret the upstream sends: a name only, the value is sealed per gate (SEC-31). */
  readonly secret: string;
  /**
   * A first request through the gate (FR-73 «Testen»), as JSON text the person may change. It
   * reaches the real API: the wizard says what it does before it is sent.
   */
  readonly testBody: string;
}

export const RECIPES: Readonly<Record<RecipeId, Recipe>> = {
  'hubspot-newsletter': {
    id: 'hubspot-newsletter',
    upstream: {
      name: 'hubspot',
      input: {
        origin: 'https://api.hubapi.com',
        auth: { type: 'bearer', secret: 'hubspot-token' },
        timeout: '10s',
      },
    },
    route: {
      name: 'newsletter',
      input: {
        method: 'POST',
        path: '/newsletter',
        upstream: 'hubspot',
        upstreamPath: '/crm/v3/objects/contacts',
        maxBodySize: '4KiB',
        rateLimit: { requests: 5, window: '10m' },
        quota: { requests: 500, period: 'day' },
      },
    },
    secret: 'hubspot-token',
    testBody: `${JSON.stringify(
      { properties: { email: 'test@example.com' } },
      null,
      2,
    )}\n`,
  },
  'openai-chat': {
    id: 'openai-chat',
    upstream: {
      name: 'openai',
      input: {
        origin: 'https://api.openai.com',
        auth: { type: 'bearer', secret: 'openai-key' },
        timeout: '60s',
      },
    },
    route: {
      name: 'chat',
      input: {
        method: 'POST',
        path: '/chat',
        upstream: 'openai',
        upstreamPath: '/v1/chat/completions',
        maxBodySize: '32KiB',
        rateLimit: { requests: 20, window: '10m' },
        budget: {
          usage: 'openai',
          period: 'day',
          maxOutputTokens: 4000,
          tokens: 500_000,
          cost: {
            limit: '5.00',
            inputPerMillion: '2.50',
            outputPerMillion: '10.00',
          },
        },
      },
    },
    secret: 'openai-key',
    testBody: `${JSON.stringify(
      {
        model: 'gpt-4o-mini',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say hello.' }],
      },
      null,
      2,
    )}\n`,
  },
};

/** Its form is checked by the schema when the route is written (`value_invalid`, `origins.<n>`). */
const SITE_ORIGIN = z.string().max(2048);

/** What the person chooses when applying a recipe. */
export const RecipeParams = z.strictObject({
  /** Browser origins of the website that calls the route; none = any (FR-15 is still local). */
  origins: z.array(SITE_ORIGIN).max(10).optional(),
});
export type RecipeParams = z.infer<typeof RecipeParams>;

export function isRecipeId(value: string): value is RecipeId {
  return (RECIPE_IDS as readonly string[]).includes(value);
}

/**
 * moat.yaml with the recipe's upstream and route added. Refused (ConfigEditError) when either name
 * is taken — a recipe never changes what is there — or a parameter is not valid (`value_invalid`).
 */
export function applyRecipe(
  text: string,
  id: RecipeId,
  params: RecipeParams = {},
): string {
  const parsed = RecipeParams.safeParse(params);
  if (!parsed.success)
    throw new ConfigEditError(
      'value_invalid',
      'recipe parameters are not valid',
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  const recipe = RECIPES[id];
  const config = loadMoatYaml(text);
  if (Object.hasOwn(config.routes, recipe.route.name))
    throw new ConfigEditError(
      'route_exists',
      `route "${recipe.route.name}" exists`,
    );
  const origins = parsed.data.origins ?? [];
  const withUpstream = setUpstream(
    text,
    recipe.upstream.name,
    recipe.upstream.input,
    'create',
  );
  return setRoute(
    withUpstream,
    recipe.route.name,
    origins.length === 0
      ? recipe.route.input
      : { ...recipe.route.input, origins },
    'create',
  );
}
