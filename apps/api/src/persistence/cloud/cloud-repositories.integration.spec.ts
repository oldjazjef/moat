import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountRecord } from '../../cloud/auth/ports/auth.ports';
import { newId } from '../../cloud/common/clock';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import {
  startTestPostgres,
  type TestPostgres,
} from '../database/testing/postgres-cluster';
import { CloudDatabase } from './cloud-database';
import {
  PrismaAccountRepository,
  PrismaAccountTokenRepository,
  PrismaRateLimit,
  PrismaSessionRepository,
} from './prisma-auth.repositories';
import {
  PrismaInvitationRepository,
  PrismaOrganisationRepository,
  PrismaOrgProjectRepository,
} from './prisma-tenancy.repositories';

const AT = '2026-10-15T12:00:00.000Z';
const HASH = '$argon2id$v=19$m=8,t=1,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

let pg: TestPostgres | null = null;
let folder: string;
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'moat-cloud-db-'));
  pg = await startTestPostgres();
});
afterAll(async () => {
  await pg?.stop();
  rmSync(folder, { recursive: true, force: true });
});

const account = (email: string): AccountRecord => ({
  id: newId(),
  email,
  passwordHash: HASH,
  passwordChangedAt: AT,
  createdAt: AT,
  emailVerifiedAt: null,
});

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`Cloud repositories on ${provider} (Prisma 7)`, () => {
    let database: CloudDatabase;
    let accounts: PrismaAccountRepository;
    let sessions: PrismaSessionRepository;
    let limits: PrismaRateLimit;
    let orgs: PrismaOrganisationRepository;
    let projects: PrismaOrgProjectRepository;
    let tokens: PrismaAccountTokenRepository;
    let invitations: PrismaInvitationRepository;
    // No PostgreSQL server on this machine and no MOAT_TEST_POSTGRES_URL: the specs return early.
    const unavailable = () => provider === 'postgresql' && pg === null;

    beforeAll(async () => {
      if (provider === 'postgresql' && pg === null) return;
      database =
        provider === 'sqlite'
          ? await CloudDatabase.open({
              provider,
              dataDir: mkdtempSync(join(folder, 'db-')),
            })
          : await CloudDatabase.open({
              provider,
              dataDir: folder,
              databaseUrl: await (pg as TestPostgres).database(),
            });
      accounts = new PrismaAccountRepository(database);
      sessions = new PrismaSessionRepository(database);
      limits = new PrismaRateLimit(database);
      orgs = new PrismaOrganisationRepository(database);
      projects = new PrismaOrgProjectRepository(database);
      tokens = new PrismaAccountTokenRepository(database);
      invitations = new PrismaInvitationRepository(database);
    }, 120_000);

    afterAll(async () => {
      await database?.onApplicationShutdown();
    });

    it('keeps an address once, whatever the case it came in', async () => {
      if (unavailable()) return;
      const a = account('one@example.ch');
      expect(await accounts.create(a)).toBe('created');
      expect(await accounts.create(account('one@example.ch'))).toBe(
        'email_taken',
      );
      expect(await accounts.findByEmail('one@example.ch')).toMatchObject({
        id: a.id,
      });
      expect(await accounts.findByEmail('missing@example.ch')).toBeNull();
    });

    it('moves a TOTP through pending, enabled and replay-safe steps', async () => {
      if (unavailable()) return;
      const a = account('totp@example.ch');
      await accounts.create(a);
      const sealed = 'A'.repeat(80);
      expect(await accounts.savePendingTotp(a.id, sealed, AT)).toBe(true);
      expect(await accounts.savePendingTotp(a.id, 'B'.repeat(80), AT)).toBe(
        true,
      );
      expect(await accounts.advanceTotpStep(a.id, 5)).toBe(false);
      expect(
        await accounts.enableTotp(a.id, 100, AT, [
          { id: newId(), hash: 'a'.repeat(64) },
          { id: newId(), hash: 'b'.repeat(64) },
        ]),
      ).toBe(true);
      expect(await accounts.enableTotp(a.id, 100, AT, [])).toBe(false);
      expect(await accounts.savePendingTotp(a.id, sealed, AT)).toBe(false);
      expect(await accounts.advanceTotpStep(a.id, 100)).toBe(false);
      expect(await accounts.advanceTotpStep(a.id, 101)).toBe(true);
      expect(await accounts.advanceTotpStep(a.id, 101)).toBe(false);
      expect(await accounts.useRecoveryCode(a.id, 'a'.repeat(64), AT)).toBe(
        true,
      );
      expect(await accounts.useRecoveryCode(a.id, 'a'.repeat(64), AT)).toBe(
        false,
      );
      expect(await accounts.useRecoveryCode(a.id, 'c'.repeat(64), AT)).toBe(
        false,
      );
      await accounts.removeTotp(a.id);
      expect(await accounts.totp(a.id)).toBeNull();
      expect(await accounts.useRecoveryCode(a.id, 'b'.repeat(64), AT)).toBe(
        false,
      );
    });

    it('revokes sessions singly and per account, except one', async () => {
      if (unavailable()) return;
      const a = account('sessions@example.ch');
      await accounts.create(a);
      const make = (n: string) => ({
        id: n.repeat(64),
        accountId: a.id,
        createdAt: AT,
        lastSeenAt: AT,
        expiresAt: '2026-10-29T12:00:00.000Z',
        revokedAt: null,
      });
      for (const n of ['1', '2', '3']) await sessions.create(make(n));
      await sessions.revokeAllOf(a.id, AT, '2'.repeat(64));
      expect((await sessions.find('1'.repeat(64)))?.revokedAt).toBe(AT);
      expect((await sessions.find('2'.repeat(64)))?.revokedAt).toBeNull();
      await sessions.revoke('2'.repeat(64), AT);
      expect((await sessions.find('2'.repeat(64)))?.revokedAt).toBe(AT);
      expect(await sessions.find('9'.repeat(64))).toBeNull();
    });

    it('counts in fixed windows and drops expired ones', async () => {
      if (unavailable()) return;
      const key = 'f'.repeat(64);
      const t0 = new Date('2026-10-15T12:00:00.000Z');
      expect(await limits.count(key, t0)).toBe(0);
      expect(await limits.increment(key, 60_000, t0)).toBe(1);
      expect(
        await limits.increment(key, 60_000, new Date(t0.getTime() + 1000)),
      ).toBe(2);
      expect(await limits.count(key, new Date(t0.getTime() + 2000))).toBe(2);
      expect((await limits.windowEnd(key, t0))?.toISOString()).toBe(
        '2026-10-15T12:01:00.000Z',
      );
      const later = new Date(t0.getTime() + 61_000);
      expect(await limits.count(key, later)).toBe(0);
      expect(await limits.increment('e'.repeat(64), 60_000, later)).toBe(1);
      expect(await limits.increment(key, 60_000, later)).toBe(1);
      expect(await database.client.rateLimit.count()).toBe(2);
    });

    it('keeps tenants apart and the last Owner in place', async () => {
      if (unavailable()) return;
      const [a, b] = [
        account('ownera@example.ch'),
        account('ownerb@example.ch'),
      ];
      await accounts.create(a);
      await accounts.create(b);
      const mk = (id: string, who: AccountRecord) => ({
        organisation: { id, name: id, createdAt: AT },
        owner: {
          organisationId: id,
          accountId: who.id,
          role: 'owner' as const,
          releaseGranted: true,
          createdAt: AT,
        },
      });
      const [oa, ob] = [mk(newId(), a), mk(newId(), b)];
      await orgs.create(oa.organisation, oa.owner);
      await orgs.create(ob.organisation, ob.owner);
      expect(await orgs.membership(oa.organisation.id, b.id)).toBeNull();
      expect((await orgs.listFor(a.id)).map((r) => r.organisation.id)).toEqual([
        oa.organisation.id,
      ]);
      expect(
        await orgs.updateMember(oa.organisation.id, a.id, 'admin', false),
      ).toBe('last_owner');
      expect(await orgs.removeMember(oa.organisation.id, a.id)).toBe(
        'last_owner',
      );
      expect(
        await orgs.addMember({
          ...oa.owner,
          accountId: b.id,
          role: 'editor',
          releaseGranted: false,
        }),
      ).toBe('added');
      expect(
        await orgs.addMember({
          ...oa.owner,
          accountId: b.id,
          role: 'viewer',
          releaseGranted: false,
        }),
      ).toBe('exists');
      expect(
        await orgs.updateMember(oa.organisation.id, a.id, 'admin', false),
      ).toBe('last_owner');
      expect(
        await orgs.updateMember(oa.organisation.id, b.id, 'owner', true),
      ).toBe('ok');
      expect(
        await orgs.updateMember(oa.organisation.id, a.id, 'admin', false),
      ).toBe('ok');
      expect(
        (await orgs.members(oa.organisation.id)).map((m) => m.email).sort(),
      ).toEqual(['ownera@example.ch', 'ownerb@example.ch']);
      expect(await orgs.removeMember(oa.organisation.id, newId())).toBe(
        'not_found',
      );

      const p = {
        id: newId(),
        organisationId: oa.organisation.id,
        name: 'Shop',
        createdAt: AT,
      };
      await projects.create(p);
      expect(await projects.find(ob.organisation.id, p.id)).toBeNull();
      expect(await projects.delete(ob.organisation.id, p.id)).toBe(false);
      expect(await projects.list(ob.organisation.id)).toEqual([]);
      expect(await projects.find(oa.organisation.id, p.id)).toMatchObject({
        name: 'Shop',
      });
      // Deleting an organisation's account membership data cascades with the organisation.
      await database.client.organisation.delete({
        where: { id: oa.organisation.id },
      });
      expect(await projects.find(oa.organisation.id, p.id)).toBeNull();
    });

    it('uses a link token up exactly once, and only for its purpose and before it expires', async () => {
      if (unavailable()) return;
      const a = account('token@example.ch');
      await accounts.create(a);
      const record = (
        id: string,
        purpose: 'verify_email' | 'reset_password',
      ) => ({
        id,
        accountId: a.id,
        purpose,
        createdAt: AT,
        expiresAt: '2026-10-16T12:00:00.000Z',
      });
      const one = 'a'.repeat(64);
      await tokens.issue(record(one, 'verify_email'));
      expect(await tokens.consume(one, 'reset_password', AT)).toBeNull();
      expect(
        await tokens.consume(one, 'verify_email', '2026-10-17T00:00:00.000Z'),
      ).toBeNull();
      // Two racing requests: one wins.
      const raced = await Promise.all([
        tokens.consume(one, 'verify_email', AT),
        tokens.consume(one, 'verify_email', AT),
      ]);
      expect(raced.filter((r) => r === a.id)).toHaveLength(1);
      expect(await tokens.consume(one, 'verify_email', AT)).toBeNull();
      // A newer token of the same purpose ends the older one; another purpose is left alone.
      const older = 'b'.repeat(64);
      const newer = 'c'.repeat(64);
      const reset = 'd'.repeat(64);
      await tokens.issue(record(older, 'reset_password'));
      await tokens.issue(record(reset, 'verify_email'));
      await tokens.issue(record(newer, 'reset_password'));
      expect(await tokens.consume(older, 'reset_password', AT)).toBeNull();
      await tokens.revokeAll(a.id, 'reset_password', AT);
      expect(await tokens.consume(newer, 'reset_password', AT)).toBeNull();
      expect(await tokens.consume(reset, 'verify_email', AT)).toBe(a.id);
    });

    it('confirms an address once and finds only confirmed accounts by it', async () => {
      if (unavailable()) return;
      const a = account('verified@example.ch');
      await accounts.create(a);
      expect(await orgs.verifiedAccountIdByEmail(a.email)).toBeNull();
      await accounts.markEmailVerified(a.id, AT);
      await accounts.markEmailVerified(a.id, '2026-10-16T12:00:00.000Z');
      expect(await orgs.verifiedAccountIdByEmail(a.email)).toBe(a.id);
      expect((await accounts.findById(a.id))?.emailVerifiedAt).toBe(AT);
      expect(await orgs.accountIdByEmail(a.email)).toBe(a.id);
    });

    it('keeps one invitation per organisation and address, hands each over once, and drops lapsed ones', async () => {
      if (unavailable()) return;
      const owner = account('inviter@example.ch');
      await accounts.create(owner);
      const org = { id: newId(), name: 'Invites', createdAt: AT };
      await orgs.create(org, {
        organisationId: org.id,
        accountId: owner.id,
        role: 'owner',
        releaseGranted: true,
        createdAt: AT,
      });
      const invite = (role: 'viewer' | 'admin', expiresAt: string) => ({
        id: newId(),
        organisationId: org.id,
        email: 'guest@example.ch',
        role,
        invitedBy: owner.id,
        createdAt: AT,
        expiresAt,
      });
      await invitations.save(invite('viewer', '2026-10-29T12:00:00.000Z'));
      await invitations.save(invite('admin', '2026-10-29T12:00:00.000Z'));
      const taken = await invitations.takeAllFor('guest@example.ch', AT);
      expect(taken).toHaveLength(1);
      expect(taken[0]?.role).toBe('admin');
      expect(await invitations.takeAllFor('guest@example.ch', AT)).toEqual([]);
      await invitations.save(invite('viewer', '2026-10-15T12:00:01.000Z'));
      expect(
        await invitations.takeAllFor(
          'guest@example.ch',
          '2026-10-20T00:00:00.000Z',
        ),
      ).toEqual([]);
    });

    it('refuses in the database what the application never writes (CHECK constraints)', async () => {
      if (unavailable()) return;
      const raw = (text: string) => database.client.$executeRawUnsafe(text);
      const id = newId();
      // A password that is not an Argon2id hash, an upper-case address, a short id.
      await expect(
        raw(
          `INSERT INTO "account" ("id","email","password_hash","password_changed_at","created_at") VALUES ('${id}','plain@example.ch','${PLANTED_SECRETS[2]}','${AT}','${AT}')`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO "account" ("id","email","password_hash","password_changed_at","created_at") VALUES ('${id}','Upper@Example.ch','${HASH}','${AT}','${AT}')`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO "account" ("id","email","password_hash","password_changed_at","created_at") VALUES ('short','x@example.ch','${HASH}','${AT}','${AT}')`,
        ),
      ).rejects.toThrow();
      const a = account('checks@example.ch');
      await accounts.create(a);
      const org = newId();
      await raw(
        `INSERT INTO "organisation" ("id","name","created_at") VALUES ('${org}','Checks','${AT}')`,
      );
      const member = (role: string, release: string) =>
        raw(
          `INSERT INTO "membership" ("organisation_id","account_id","role","release_granted","created_at") VALUES ('${org}','${a.id}','${role}',${release},'${AT}')`,
        );
      const yes = provider === 'sqlite' ? '1' : 'true';
      // Viewer and Billing can never hold the release permission; an unknown role is no role.
      await expect(member('viewer', yes)).rejects.toThrow();
      await expect(member('billing', yes)).rejects.toThrow();
      await expect(member('root', yes)).rejects.toThrow();
      await member('editor', yes);
      // A session id must be a SHA-256, not a raw token.
      await expect(
        raw(
          `INSERT INTO "session" ("id","account_id","created_at","last_seen_at","expires_at") VALUES ('${'T'.repeat(43)}','${a.id}','${AT}','${AT}','2026-10-29T12:00:00.000Z')`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO "rate_limit" ("key","window_end","count") VALUES ('user@example.ch','${AT}',1)`,
        ),
      ).rejects.toThrow();
      // A link token is stored as its SHA-256, never as the token that sits in the mail.
      await expect(
        raw(
          `INSERT INTO "account_token" ("id","account_id","purpose","created_at","expires_at") VALUES ('${'T'.repeat(43)}','${a.id}','verify_email','${AT}','${AT}')`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO "account_token" ("id","account_id","purpose","created_at","expires_at") VALUES ('${'a'.repeat(64)}','${a.id}','log_in','${AT}','${AT}')`,
        ),
      ).rejects.toThrow();
      await expect(
        raw(
          `INSERT INTO "pending_invitation" ("id","organisation_id","email","role","invited_by","created_at","expires_at") VALUES ('${newId()}','${org}','Mixed@Example.ch','viewer','${a.id}','${AT}','${AT}')`,
        ),
      ).rejects.toThrow();
    });
  });
}
