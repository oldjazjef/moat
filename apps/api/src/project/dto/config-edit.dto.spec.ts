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
