import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import { csrfTokenOf } from '../auth/domain/session';
import {
  type CloudHarness,
  type Reply,
  startCloudHarness,
} from '../testing/cloud-harness';

/**
 * The audit log over HTTP (docs/SECURITY-TESTING.md: A01, A09, API1, API3; SEC-53, FR-53). The
 * matrix covers every route × identity; these are the flows: what a real request leaves in the
 * log, what the exports hold, and what they must not.
 */
const PASSWORD = PLANTED_SECRETS[2];
let cloud: CloudHarness;
let counter = 0;

beforeAll(async () => {
  cloud = await startCloudHarness({ MOAT_TRUST_PROXY: '1' });
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
});

const ip = () => ({ 'x-forwarded-for': `10.7.0.${(counter += 1) % 250}` });

interface Session {
  readonly email: string;
  readonly token: string;
  readonly csrf: string;
}

async function account(name: string): Promise<Session> {
  const email = `${name}${counter}@example.ch`;
  await cloud.call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD },
    headers: ip(),
  });
  const login = await cloud.call('POST', '/api/auth/login', {
    body: { email, password: PASSWORD },
    headers: ip(),
  });
  const token =
    /=([A-Za-z0-9_-]{43});/.exec(login.setCookies[0] ?? '')?.[1] ?? '';
  return { email, token, csrf: csrfTokenOf(token) };
}
const as = (s: Session) => ({ token: s.token, csrf: s.csrf });
const read = (s: Session) => ({ token: s.token });

async function organisationWith(): Promise<{
  owner: Session;
  viewer: Session;
  org: string;
}> {
  const owner = await account('owner');
  const viewer = await account('viewer');
  const made = await cloud.call('POST', '/api/orgs', {
    ...as(owner),
    body: { name: 'Acme AG' },
  });
  const org = made.json<{ organisation: { id: string } }>().organisation.id;
  const added = await cloud.call('POST', `/api/orgs/${org}/members`, {
    ...as(owner),
    body: { email: viewer.email, role: 'viewer' },
  });
  expect(added.status).toBe(204);
  const project = await cloud.call('POST', `/api/orgs/${org}/projects`, {
    ...as(owner),
    body: { name: 'Shop' },
  });
  expect(project.status).toBe(201);
  return { owner, viewer, org };
}

interface Entry {
  seq: number;
  action: string;
  actor: string;
  target: string | null;
  details: string;
  hash: string;
}
const entries = (reply: Reply) => reply.json<{ entries: Entry[] }>().entries;

describe('audit log over HTTP (SEC-53)', () => {
  it('holds what the requests did, in order, and verifies', async () => {
    const { owner, org } = await organisationWith();
    const list = await cloud.call('GET', `/api/orgs/${org}/audit`, read(owner));
    expect(list.status).toBe(200);
    expect(entries(list).map((e) => e.action)).toEqual([
      'org.create',
      'member.add_requested',
      'project.create',
    ]);
    const verified = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit/verify`,
      read(owner),
    );
    expect(verified.json()).toMatchObject({
      check: { status: 'intact', entries: 3 },
      head: { seq: 3 },
    });
  });

  it('fails the check against a head the auditor wrote down when the log is now shorter or different', async () => {
    const { owner, org } = await organisationWith();
    const head = (
      await cloud.call('GET', `/api/orgs/${org}/audit/verify`, read(owner))
    ).json<{ head: { seq: number; hash: string } }>().head;
    const same = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit/verify?headSeq=${head.seq}&headHash=${head.hash}`,
      read(owner),
    );
    expect(same.json()).toMatchObject({ check: { status: 'intact' } });
    const tooLong = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit/verify?headSeq=${head.seq + 1}&headHash=${head.hash}`,
      read(owner),
    );
    expect(tooLong.json()).toMatchObject({
      check: { status: 'broken', reason: 'head' },
    });
    const wrong = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit/verify?headSeq=${head.seq}&headHash=${'0'.repeat(64)}`,
      read(owner),
    );
    expect(wrong.json()).toMatchObject({
      check: { status: 'broken', reason: 'head' },
    });
  });

  it('never records an address, a name or a password: only ids, roles and a hash', async () => {
    const { owner, viewer, org } = await organisationWith();
    const everything = [
      (await cloud.call('GET', `/api/orgs/${org}/audit`, read(owner))).body,
      (
        await cloud.call(
          'GET',
          `/api/orgs/${org}/audit/export?format=csv`,
          read(owner),
        )
      ).body,
      (await cloud.call('GET', `/api/orgs/${org}/audit/export`, read(owner)))
        .body,
    ].join('\n');
    expect(everything).not.toContain(viewer.email);
    expect(everything).not.toContain('example.ch');
    expect(everything).not.toContain('Acme');
    expect(everything).not.toContain('Shop');
    for (const secret of PLANTED_SECRETS)
      expect(everything).not.toContain(secret);
  });

  it('exports JSON and CSV with the headers of a download, and refuses an unknown format', async () => {
    const { owner, org } = await organisationWith();
    const csv = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit/export?format=csv`,
      read(owner),
    );
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(String(csv.headers['content-disposition'])).toContain('attachment');
    expect(String(csv.headers['cache-control'])).toContain('no-store');
    expect(csv.body.split('\r\n')[0]).toBe(
      'seq,organisationId,at,actor,action,target,details,prevHash,hash',
    );
    expect(csv.body.trimEnd().split('\r\n')).toHaveLength(4);
    const json = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit/export`,
      read(owner),
    );
    expect(String(json.headers['content-type'])).toContain('application/json');
    expect(json.json<{ entries: unknown[]; next: unknown }>()).toMatchObject({
      next: null,
    });
    for (const bad of ['xml', 'CSV', '']) {
      const refused = await cloud.call(
        'GET',
        `/api/orgs/${org}/audit/export?format=${bad}`,
        read(owner),
      );
      expect(refused.status).toBe(400);
    }
  });

  it('pages, and refuses malformed paging and head parameters with a 400', async () => {
    const { owner, org } = await organisationWith();
    const page = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit?limit=2`,
      read(owner),
    );
    expect(page.json()).toMatchObject({ next: 2 });
    expect(entries(page)).toHaveLength(2);
    const rest = await cloud.call(
      'GET',
      `/api/orgs/${org}/audit?after=2&limit=2`,
      read(owner),
    );
    expect(entries(rest).map((e) => e.seq)).toEqual([3]);
    for (const query of [
      'after=-1',
      'after=abc',
      'after=1e3',
      'limit=0',
      'limit=201',
      'limit=2&limit=3',
      'after=9999999999',
    ])
      expect(
        (
          await cloud.call(
            'GET',
            `/api/orgs/${org}/audit?${query}`,
            read(owner),
          )
        ).status,
        query,
      ).toBe(400);
    for (const query of [
      'headSeq=1',
      `headHash=${'0'.repeat(64)}`,
      'headSeq=1&headHash=zz',
      `headSeq=0&headHash=${'0'.repeat(64)}`,
    ])
      expect(
        (
          await cloud.call(
            'GET',
            `/api/orgs/${org}/audit/verify?${query}`,
            read(owner),
          )
        ).status,
        query,
      ).toBe(400);
  });

  it("answers a viewer 403 and another organisation's Owner 404, and no write verb exists", async () => {
    const { owner, viewer, org } = await organisationWith();
    const stranger = await account('stranger');
    for (const path of ['', '/verify', '/export']) {
      expect(
        (await cloud.call('GET', `/api/orgs/${org}/audit${path}`, read(viewer)))
          .status,
      ).toBe(403);
      expect(
        (
          await cloud.call(
            'GET',
            `/api/orgs/${org}/audit${path}`,
            read(stranger),
          )
        ).status,
      ).toBe(404);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(
        (
          await cloud.call(method, `/api/orgs/${org}/audit`, {
            ...as(owner),
            body: {},
          })
        ).status,
      ).toBe(404);
  });
});
