import { applyRecipe } from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../../project/testing/in-memory-projects';
import {
  DryRunHandler,
  DryRunQuery,
  type DryRunInput,
} from './dry-run.handler';

const BASE = 'version: 1\nupstreams: {}\nroutes: {}\n';
const SIGNUP: DryRunInput = {
  method: 'POST',
  path: '/newsletter',
  origin: null,
  contentType: 'application/json',
  requestMethod: null,
  body: '{"properties":{"email":"test@example.com"}}',
};

function setup() {
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': { 'moat.yaml': applyRecipe(BASE, 'hubspot-newsletter') },
    '/sites/empty': {},
  });
  return {
    id: registry.add('/sites/shop').id,
    empty: registry.add('/sites/empty').id,
    handler: new DryRunHandler(registry, files),
  };
}

describe('DryRunHandler (FR-42)', () => {
  it('answers what the gate would send, with a placeholder for the secret', async () => {
    const { id, handler } = setup();
    const result = await handler.execute(new DryRunQuery(id, null, SIGNUP));
    expect(result).toMatchObject({
      status: 'ok',
      result: {
        kind: 'forwarded',
        route: 'newsletter',
        call: {
          method: 'POST',
          url: 'https://api.hubapi.com/crm/v3/objects/contacts',
          secret: 'hubspot-token',
        },
      },
    });
    expect(JSON.stringify(result)).toContain('Bearer <SECRET>');
  });

  it('predicts refusals from the config: wrong media type, unknown path', async () => {
    const { id, handler } = setup();
    const refused = (input: Partial<DryRunInput>) =>
      handler.execute(new DryRunQuery(id, null, { ...SIGNUP, ...input }));
    expect(await refused({ contentType: 'text/plain' })).toMatchObject({
      result: { kind: 'refused', status: 415, error: 'unsupported_media_type' },
    });
    expect(await refused({ path: '/nope' })).toMatchObject({
      result: { kind: 'refused', status: 404, error: 'not_found' },
    });
  });

  it('refuses an unknown gate, a project without config and a foreign id', async () => {
    const { id, empty, handler } = setup();
    expect(await handler.execute(new DryRunQuery(id, 'www', SIGNUP))).toEqual({
      status: 'refused',
      code: 'gate_unknown',
    });
    expect(await handler.execute(new DryRunQuery(empty, null, SIGNUP))).toEqual(
      {
        status: 'refused',
        code: 'config_missing',
      },
    );
    expect(
      await handler.execute(
        new DryRunQuery('zzzzzzzzzzzzzzzzzzzzzz', null, SIGNUP),
      ),
    ).toEqual({ status: 'not_found' });
  });
});
