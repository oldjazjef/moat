import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { toConfigEdit, type ConfigEditDto } from './config-edit.dto';

const BASE = '0'.repeat(64);
const update = (auth: Record<string, string>) =>
  toConfigEdit({
    base: BASE,
    op: 'updateUpstream',
    upstream: 'crm',
    upstreamDefinition: { origin: 'https://api.example.com', auth },
  } as unknown as ConfigEditDto);

describe('toConfigEdit: upstream auth (FR-20)', () => {
  it('takes Basic with its user name', () => {
    expect(
      update({ type: 'basic', username: 'moat', secret: 'crm-key' }),
    ).toMatchObject({
      upstreamDefinition: {
        auth: { type: 'basic', username: 'moat', secret: 'crm-key' },
      },
    });
  });

  it('takes OAuth2 with or without a scope', () => {
    const oauth = {
      type: 'oauth2',
      tokenUrl: 'https://auth.example.com/token',
      clientId: 'moat',
      secret: 'crm-key',
    };
    expect(update(oauth)).toMatchObject({
      upstreamDefinition: { auth: oauth },
    });
    expect(update({ ...oauth, scope: 'read' })).toMatchObject({
      upstreamDefinition: { auth: { ...oauth, scope: 'read' } },
    });
  });

  it('refuses a field of another type (400)', () => {
    expect(
      update({ type: 'basic', username: 'm', param: 'x', secret: 'k' }),
    ).toBeNull();
    expect(update({ type: 'basic', secret: 'k' })).toBeNull();
    expect(
      update({
        type: 'oauth2',
        tokenUrl: 'https://a.example.com/t',
        secret: 'k',
      }),
    ).toBeNull();
    expect(update({ type: 'bearer', scope: 'read', secret: 'k' })).toBeNull();
  });
});

describe('toConfigEdit: client checks (FR-16)', () => {
  it('passes API key, Turnstile and honeypot on, nothing else', () => {
    const edit = toConfigEdit({
      base: BASE,
      op: 'updateRoute',
      route: 'newsletter',
      definition: {
        method: 'POST',
        path: '/newsletter',
        upstream: 'crm',
        upstreamPath: '/contacts',
        client: {
          apiKey: { secret: 'client-key', header: 'X-Key' },
          turnstile: { secret: 'turnstile-key' },
          honeypot: { field: 'website' },
          extra: { field: 'x' },
        },
      },
    } as unknown as ConfigEditDto);
    expect(edit).toMatchObject({
      definition: {
        client: {
          apiKey: { secret: 'client-key', header: 'X-Key' },
          turnstile: { secret: 'turnstile-key' },
          honeypot: { field: 'website' },
        },
      },
    });
    expect(
      (edit as { definition: { client: object } }).definition.client,
    ).not.toHaveProperty('extra');
  });
});
