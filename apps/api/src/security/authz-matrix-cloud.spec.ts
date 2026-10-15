import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../cloud/auth/application/password-hasher';
import { SessionIssuer } from '../cloud/auth/application/session-issuer';
import { csrfTokenOf, sessionIdOf } from '../cloud/auth/domain/session';
import {
  AccountRepositoryPort,
  SessionRepositoryPort,
} from '../cloud/auth/ports/auth.ports';
import {
  type CloudHarness,
  startCloudHarness,
} from '../cloud/testing/cloud-harness';
import type { Role } from '../cloud/tenancy/domain/permissions';
import {
  OrganisationRepositoryPort,
  OrgProjectRepositoryPort,
} from '../cloud/tenancy/ports/tenancy.ports';
import { CloudDatabase } from '../persistence/cloud/cloud-database';
import {
  CLOUD_AUTHZ_MATRIX,
  CLOUD_IDENTITIES,
  CLOUD_IDS,
  CLOUD_MATRIX_PASSWORD,
  CLOUD_TARGET_EMAIL,
  type CloudIdentity,
} from './authz-matrix-cloud';

const AT = '2026-10-15T12:00:00.000Z';
const ACCOUNTS = {
  ownerA: { role: 'owner', release: true },
  adminA: { role: 'admin', release: false },
  editorA: { role: 'editor', release: true },
  editorANoRelease: { role: 'editor', release: false },
  viewerA: { role: 'viewer', release: false },
  billingA: { role: 'billing', release: false },
} as const satisfies Record<string, { role: Role; release: boolean }>;
type Member = keyof typeof ACCOUNTS;
const idOf = (name: string) =>
  name === 'target' ? CLOUD_IDS.target : name.padEnd(22, '0');

let cloud: CloudHarness;
let passwordHash: string;

function services() {
  return {
    accounts: cloud.get(AccountRepositoryPort),
    sessions: cloud.get(SessionRepositoryPort),
    organisations: cloud.get(OrganisationRepositoryPort),
    projects: cloud.get(OrgProjectRepositoryPort),
    issuer: cloud.get(SessionIssuer),
    database: cloud.get(CloudDatabase),
  };
}

async function seedOnce(): Promise<void> {
  const s = services();
  passwordHash = await cloud.get(PasswordHasher).hash(CLOUD_MATRIX_PASSWORD);
  const people = [
    ...Object.keys(ACCOUNTS).map((name) => [
      name,
      `${name.toLowerCase()}@example.ch`,
    ]),
    ['ownerB', 'ownerb@example.ch'],
    ['target', CLOUD_TARGET_EMAIL],
  ] as const;
  for (const [name, email] of people)
    await s.accounts.create({
      id: idOf(name),
      email,
      passwordHash,
      passwordChangedAt: AT,
      createdAt: AT,
    });
  const owner = (organisationId: string, accountId: string) => ({
    organisationId,
    accountId,
    role: 'owner' as const,
    releaseGranted: true,
    createdAt: AT,
  });
  await s.organisations.create(
    { id: CLOUD_IDS.orgA, name: 'Org A', createdAt: AT },
    owner(CLOUD_IDS.orgA, idOf('ownerA')),
  );
  await s.organisations.create(
    { id: CLOUD_IDS.orgB, name: 'Org B', createdAt: AT },
    owner(CLOUD_IDS.orgB, idOf('ownerB')),
  );
  for (const name of Object.keys(ACCOUNTS) as Member[]) {
    if (name === 'ownerA') continue;
    await s.organisations.addMember({
      organisationId: CLOUD_IDS.orgA,
      accountId: idOf(name),
      role: ACCOUNTS[name].role,
      releaseGranted: ACCOUNTS[name].release,
      createdAt: AT,
    });
  }
}

interface Fixture {
  readonly tokens: Record<Member | 'ownerB' | 'expired' | 'revoked', string>;
}

/** Fresh state before every cell: a request may change anything it is allowed to change. */
async function reseed(): Promise<Fixture> {
  const s = services();
  const now = new Date().toISOString();
  for (const name of [...Object.keys(ACCOUNTS), 'ownerB', 'target']) {
    await s.accounts.changePassword(idOf(name), passwordHash, now);
    await s.accounts.removeTotp(idOf(name));
    await s.sessions.revokeAllOf(idOf(name), now);
  }
  await s.database.client.rateLimit.deleteMany();
  // The member routes act on `target`: a Viewer of organisation A, without the release permission.
  await s.organisations.removeMember(CLOUD_IDS.orgA, CLOUD_IDS.target);
  await s.organisations.addMember({
    organisationId: CLOUD_IDS.orgA,
    accountId: CLOUD_IDS.target,
    role: 'viewer',
    releaseGranted: false,
    createdAt: AT,
  });
  for (const org of [CLOUD_IDS.orgA, CLOUD_IDS.orgB])
    for (const project of await s.projects.list(org))
      await s.projects.delete(org, project.id);
  await s.projects.create({
    id: CLOUD_IDS.projectA,
    organisationId: CLOUD_IDS.orgA,
    name: 'A',
    createdAt: AT,
  });
  await s.projects.create({
    id: CLOUD_IDS.projectB,
    organisationId: CLOUD_IDS.orgB,
    name: 'B',
    createdAt: AT,
  });

  const issue = async (name: string) =>
    (await s.issuer.issue(idOf(name))).token;
  const tokens = {} as Fixture['tokens'];
  for (const name of Object.keys(ACCOUNTS) as Member[])
    tokens[name] = await issue(name);
  tokens.ownerB = await issue('ownerB');
  tokens.revoked = await issue('ownerA');
  await s.sessions.revoke(sessionIdOf(tokens.revoked), now);
  // A session past its absolute end (its own token, so no other cell touches it).
  tokens.expired = 'E'.repeat(43);
  await s.database.client.session.deleteMany({
    where: { id: sessionIdOf(tokens.expired) },
  });
  await s.sessions.create({
    id: sessionIdOf(tokens.expired),
    accountId: idOf('ownerA'),
    createdAt: '2020-01-01T00:00:00.000Z',
    lastSeenAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-15T00:00:00.000Z',
    revokedAt: null,
  });
  return { tokens };
}

function requestFor(identity: CloudIdentity, fixture: Fixture) {
  const t = fixture.tokens;
  const withCsrf = (token: string) => ({ token, csrf: csrfTokenOf(token) });
  switch (identity) {
    case 'noCookie':
      return {};
    case 'garbageCookie':
      return withCsrf('g'.repeat(43));
    case 'expiredSession':
      return withCsrf(t.expired);
    case 'revokedSession':
      return withCsrf(t.revoked);
    case 'ownerB':
      return withCsrf(t.ownerB);
    case 'csrfMissing':
      return { token: t.ownerA };
    case 'csrfOfOtherSession':
      return { token: t.ownerA, csrf: csrfTokenOf(t.adminA) };
    case 'crossOrigin':
      return { ...withCsrf(t.ownerA), origin: 'https://evil.example' };
    default:
      return withCsrf(t[identity]);
  }
}

describe('authorization matrix (cloud mode)', () => {
  beforeAll(async () => {
    cloud = await startCloudHarness();
    await seedOnce();
  }, 60_000);

  afterAll(async () => {
    await cloud?.stop();
  });

  it('has an entry for every route the Cloud serves, and none for a route it does not', () => {
    const express = cloud.api.app.getHttpAdapter().getInstance() as {
      router: {
        stack: { route?: { path: string; methods: Record<string, boolean> } }[];
      };
    };
    const served = express.router.stack
      .flatMap((layer) =>
        layer.route
          ? Object.keys(layer.route.methods).map(
              (method) => `${method.toUpperCase()} ${layer.route?.path}`,
            )
          : [],
      )
      .sort();
    const listed = [
      ...new Set(CLOUD_AUTHZ_MATRIX.map((e) => `${e.method} ${e.path}`)),
    ].sort();
    expect(served).toEqual(listed);
  });

  it('gives every route an expectation for every identity', () => {
    for (const entry of CLOUD_AUTHZ_MATRIX)
      expect(Object.keys(entry.expect).sort()).toEqual(
        [...CLOUD_IDENTITIES].sort(),
      );
  });

  for (const entry of CLOUD_AUTHZ_MATRIX) {
    for (const identity of CLOUD_IDENTITIES) {
      const label = entry.name === undefined ? '' : ` (${entry.name})`;
      it(`${entry.method} ${entry.path}${label} as ${identity} → ${entry.expect[identity]}`, async () => {
        const fixture = await reseed();
        const reply = await cloud.call(
          entry.method,
          entry.request ?? entry.path,
          {
            ...requestFor(identity, fixture),
            body: entry.body,
          },
        );
        expect(reply.status).toBe(entry.expect[identity]);
      }, 30_000);
    }
  }

  it('answers an unknown route 404 to everybody (no route, nothing to hide)', async () => {
    const fixture = await reseed();
    expect((await cloud.call('GET', '/api/nope')).status).toBe(404);
    expect(
      (await cloud.call('GET', '/api/nope', { token: fixture.tokens.ownerA }))
        .status,
    ).toBe(404);
  });
});
