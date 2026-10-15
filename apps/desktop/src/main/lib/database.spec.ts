import { describe, expect, it } from 'vitest';
import { DATABASE_MESSAGES } from './database-messages';
import {
  DatabaseSession,
  defaultDatabaseKey,
  type DatabaseSessionDeps,
  type DatabaseTarget,
  type SyncAnswer,
} from './database';

const URL = 'postgresql://moat:PLANTED-db-password@db.example.ch/moat';
const SIGNER = { kid: 'K'.repeat(22), publicKey: new Uint8Array(32) };

function setup(over: Partial<DatabaseSessionDeps> = {}) {
  let stored: DatabaseTarget | null = null;
  const calls: { url: string; key: string; direction: string }[] = [];
  let answer: SyncAnswer = {
    status: 'done',
    direction: 'push',
    key: 'shop',
    config: true,
    gates: 1,
    secrets: 2,
    bundles: 3,
    issues: [{ code: 'bundle_conflict', gate: 'site', name: null, version: 2 }],
  };
  const session = new DatabaseSession({
    texts: DATABASE_MESSAGES.en,
    project: 'Shop',
    defaultKey: 'shop',
    keychain: {
      available: true,
      seal: (secret) => `sealed:${Buffer.from(secret).toString('base64')}`,
      open: (sealed) =>
        sealed.startsWith('sealed:')
          ? Buffer.from(sealed.slice(7), 'base64').toString()
          : null,
    },
    stored: () => stored,
    save: (target) => {
      stored = target;
    },
    forget: () => {
      stored = null;
    },
    label: (url) =>
      url.startsWith('postgresql://')
        ? { status: 'ok', label: 'postgresql://moat@db.example.ch:5432/moat' }
        : { status: 'refused', code: 'url_invalid' },
    signer: () => SIGNER,
    sync: (url, key, direction) => {
      calls.push({ url, key, direction });
      return Promise.resolve(answer);
    },
    ...over,
  });
  return {
    session,
    calls,
    stored: () => stored,
    answer: (next: SyncAnswer) => {
      answer = next;
    },
  };
}

describe('DatabaseSession (the database window, DT-03)', () => {
  it('runs a push, remembers the URL only as keychain ciphertext, and never shows it', async () => {
    const { session, calls, stored } = setup();
    const view = await session.run({
      url: URL,
      key: 'shop',
      remember: true,
      direction: 'push',
    });
    expect(calls).toEqual([{ url: URL, key: 'shop', direction: 'push' }]);
    expect(view.result).toMatchObject({
      bundles: 3,
      issues: [{ code: 'bundle_conflict' }],
    });
    expect(JSON.stringify(view)).not.toContain('PLANTED');
    expect(stored()?.url).toMatch(/^sealed:/);
    expect(JSON.stringify(stored())).not.toContain('PLANTED');
    expect(session.outcome()).toEqual({
      status: 'done',
      direction: 'push',
      config: true,
      gates: 1,
      secrets: 2,
      bundles: 3,
      issues: 1,
    });
    // Next time: the remembered connection, opened from the keychain.
    await session.run({
      url: '',
      key: 'shop',
      remember: true,
      direction: 'pull',
    });
    expect(calls[1]).toEqual({ url: URL, key: 'shop', direction: 'pull' });
  });

  it('remembers nothing of the URL without consent or without a real keychain', async () => {
    const plain = setup();
    await plain.session.run({
      url: URL,
      key: 'shop',
      remember: false,
      direction: 'push',
    });
    expect(plain.stored()).toEqual({
      key: 'shop',
      label: 'postgresql://moat@db.example.ch:5432/moat',
      url: null,
    });
    const noKeychain = setup({
      keychain: {
        available: false,
        seal: () => {
          throw new Error('no keychain');
        },
        open: () => null,
      },
    });
    const view = await noKeychain.session.run({
      url: URL,
      key: 'shop',
      remember: true,
      direction: 'push',
    });
    expect(view.canRemember).toBe(false);
    expect(noKeychain.stored()?.url).toBeNull();
  });

  it('refuses before connecting: no URL, bad URL, bad key, no signing key', async () => {
    const { session, calls } = setup();
    expect(
      (
        await session.run({
          url: '',
          key: 'shop',
          remember: false,
          direction: 'push',
        })
      ).notice,
    ).toBe('url_missing');
    expect(
      (
        await session.run({
          url: 'mysql://x',
          key: 'shop',
          remember: false,
          direction: 'push',
        })
      ).notice,
    ).toBe('url_invalid');
    expect(
      (
        await session.run({
          url: URL,
          key: '../x',
          remember: false,
          direction: 'push',
        })
      ).notice,
    ).toBe('key_invalid');
    const keyless = setup({ signer: () => null });
    expect(
      (
        await keyless.session.run({
          url: URL,
          key: 'shop',
          remember: false,
          direction: 'push',
        })
      ).notice,
    ).toBe('key_missing');
    expect(calls).toEqual([]);
    expect(session.outcome()).toEqual({ status: 'cancelled' });
  });

  it('shows the API refusal and does not remember a connection that failed', async () => {
    const run = setup();
    run.answer({ status: 'refused', code: 'foreign_tables' });
    expect(
      (
        await run.session.run({
          url: URL,
          key: 'shop',
          remember: true,
          direction: 'push',
        })
      ).notice,
    ).toBe('foreign_tables');
    expect(run.stored()).toBeNull();
    run.answer({ status: 'changed' });
    expect(
      (
        await run.session.run({
          url: URL,
          key: 'shop',
          remember: true,
          direction: 'pull',
        })
      ).notice,
    ).toBe('changed');
  });

  it('makes a key from the folder name', () => {
    expect(defaultDatabaseKey('Mein Shop 2026')).toBe('mein-shop-2026');
    expect(defaultDatabaseKey('2026 Shop')).toBe('shop');
    expect(defaultDatabaseKey('---')).toBe('moat');
  });
});
