import { buildTrafficReport, fingerprint, toBase64Url } from '@moat/core';
import sodium from 'libsodium-wrappers-sumo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import { csrfTokenOf } from '../auth/domain/session';
import { newId } from '../common/clock';
import { type CloudHarness, startCloudHarness } from '../testing/cloud-harness';

/**
 * Traffic reports end to end over HTTP (FR-50, FR-51, T-110): an Owner makes a gate's report
 * address, the "gate" posts what the PHP gate would build (core buildTrafficReport, the same
 * vectors), and the project's traffic shows the sums. Everything a forged or foreign report could
 * try is refused, and nothing of a client ever reaches the store.
 */
const PASSWORD = PLANTED_SECRETS[2];
let cloud: CloudHarness;
let counter = 0;

beforeAll(async () => {
  await sodium.ready;
  cloud = await startCloudHarness({ MOAT_TRUST_PROXY: '1' });
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
});

const ip = () => ({ 'x-forwarded-for': `10.8.0.${(counter += 1) % 250}` });

async function account(name: string) {
  const email = `${name}${(counter += 1)}@example.ch`;
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
type Session = Awaited<ReturnType<typeof account>>;
const as = (s: Session) => ({ token: s.token, csrf: s.csrf });

async function setup() {
  const owner = await account('owner');
  const viewer = await account('viewer');
  const org = (
    await cloud.call('POST', '/api/orgs', {
      ...as(owner),
      body: { name: 'Acme' },
    })
  ).json<{ organisation: { id: string } }>().organisation.id;
  await cloud.call('POST', `/api/orgs/${org}/members`, {
    ...as(owner),
    body: { email: viewer.email, role: 'viewer' },
  });
  const project = (
    await cloud.call('POST', `/api/orgs/${org}/projects`, {
      ...as(owner),
      body: { name: 'Shop' },
    })
  ).json<{ project: { id: string } }>().project.id;
  const base = `/api/orgs/${org}/projects/${project}`;
  const pair = sodium.crypto_box_keypair();
  const gateId = newId();
  const enrolled = await cloud.call('POST', `${base}/gates`, {
    ...as(owner),
    body: {
      name: 'site',
      gateId,
      boxKey: toBase64Url(pair.publicKey),
      fingerprint: await fingerprint('x25519', pair.publicKey),
      // A signed gate: the customer's key (no installation key in this harness).
      signerKey: toBase64Url(sodium.crypto_sign_keypair().publicKey),
    },
  });
  expect(enrolled.status).toBe(201);
  return { owner, viewer, base, gateId };
}

const NOW = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;

/** What the gate would send for these log entries (the last complete hour). */
function report(gateId: string, client = 'fedcba9876543210') {
  const hour = Math.floor(NOW() / HOUR) * HOUR - HOUR;
  const entry = (status: number, error: string | null, ms: number) => ({
    t: hour + 60,
    route: 'newsletter',
    method: 'POST',
    status,
    error,
    ms,
    client,
  });
  const built = buildTrafficReport(
    gateId,
    [
      entry(200, null, 100),
      entry(200, null, 300),
      entry(429, 'rate_limited', 2),
    ],
    hour,
    NOW(),
  );
  if (built.report === null) throw new Error('nothing to report');
  return built.report;
}

const send = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  cloud.call('POST', new URL(url).pathname, {
    body,
    headers: { ...ip(), ...headers },
  });

describe('traffic reports (FR-50, FR-51, T-110)', () => {
  it('stores what the gate reported and shows the sums, never a client', async () => {
    const s = await setup();
    const made = await cloud.call(
      'POST',
      `${s.base}/gates/site/report-address`,
      as(s.owner),
    );
    expect(made.status).toBe(201);
    const { url } = made.json<{ url: string }>();
    expect(url).toMatch(
      /^https:\/\/app\.moat\.test\/api\/report\/[A-Za-z0-9_-]{43}$/,
    );

    const sent = await send(url, report(s.gateId));
    expect(sent.status).toBe(204);
    expect(sent.body).toBe('');
    // A report sent twice (a lost answer) counts once.
    expect((await send(url, report(s.gateId))).status).toBe(204);

    const traffic = await cloud.call('GET', `${s.base}/traffic`, {
      token: s.viewer.token,
    });
    expect(traffic.status).toBe(200);
    const [gate] = traffic.json<{
      gates: {
        gate: string;
        totals: Record<string, unknown>;
        errors: unknown;
        hasReportAddress: boolean;
        routes: { route: string }[];
      }[];
    }>().gates;
    expect(gate?.hasReportAddress).toBe(true);
    expect(gate?.totals).toMatchObject({
      requests: 3,
      s2: 2,
      s4: 1,
      msAverage: 134,
      msMax: 300,
    });
    expect(gate?.errors).toEqual([{ code: 'rate_limited', count: 1 }]);
    expect(gate?.routes.map((r) => r.route)).toEqual(['newsletter']);
    expect(traffic.body).not.toContain('fedcba9876543210');
    // The token itself is never stored or shown again.
    const token = url.slice(url.lastIndexOf('/') + 1);
    expect(traffic.body).not.toContain(token);
  });

  it('refuses a report for another gate, a client hash and an inconsistent sum', async () => {
    const s = await setup();
    const { url } = (
      await cloud.call(
        'POST',
        `${s.base}/gates/site/report-address`,
        as(s.owner),
      )
    ).json<{ url: string }>();
    const other = await send(url, report(newId()));
    expect(other.status).toBe(422);
    expect(other.json()).toMatchObject({ error: 'gate_mismatch' });
    const good = report(s.gateId);
    const withClient = {
      ...good,
      hours: good.hours.map((b) => ({ ...b, client: 'fedcba9876543210' })),
    };
    expect((await send(url, withClient)).json()).toMatchObject({
      error: 'report_invalid',
    });
    const wrongSum = {
      ...good,
      hours: good.hours.map((b) => ({ ...b, s2: b.s2 + 1 })),
    };
    expect((await send(url, wrongSum)).status).toBe(422);
    expect((await send(url, 'not a report')).status).toBe(422);
    const big = await send(url, { padding: 'x'.repeat(140_000) });
    expect(big.status).toBe(413);
    const traffic = await cloud.call('GET', `${s.base}/traffic`, {
      token: s.owner.token,
    });
    expect(
      traffic.json<{ gates: { totals: { requests: number } }[] }>().gates[0]
        ?.totals.requests,
    ).toBe(0);
  });

  it('ends the old address when a new one is made, and answers unknown tokens with 404', async () => {
    const s = await setup();
    const first = (
      await cloud.call(
        'POST',
        `${s.base}/gates/site/report-address`,
        as(s.owner),
      )
    ).json<{ url: string }>().url;
    const second = (
      await cloud.call(
        'POST',
        `${s.base}/gates/site/report-address`,
        as(s.owner),
      )
    ).json<{ url: string }>().url;
    expect(first).not.toBe(second);
    expect((await send(first, report(s.gateId))).status).toBe(404);
    expect((await send(second, report(s.gateId))).status).toBe(204);
    expect(
      (await send('https://x/api/report/short', report(s.gateId))).status,
    ).toBe(404);
  });

  it('refuses a cross-site post and lets only Owner and Admin make an address', async () => {
    const s = await setup();
    expect(
      (
        await cloud.call(
          'POST',
          `${s.base}/gates/site/report-address`,
          as(s.viewer),
        )
      ).status,
    ).toBe(403);
    const { url } = (
      await cloud.call(
        'POST',
        `${s.base}/gates/site/report-address`,
        as(s.owner),
      )
    ).json<{ url: string }>();
    const cross = await cloud.call('POST', new URL(url).pathname, {
      body: report(s.gateId),
      origin: 'https://evil.example',
      headers: ip(),
    });
    expect(cross.status).toBe(403);
    expect(
      (
        await cloud.call('GET', `${s.base}/traffic?days=2`, {
          token: s.owner.token,
        })
      ).status,
    ).toBe(422);
  });

  it('limits how often one gate may report', async () => {
    const s = await setup();
    const { url } = (
      await cloud.call(
        'POST',
        `${s.base}/gates/site/report-address`,
        as(s.owner),
      )
    ).json<{ url: string }>();
    const statuses: number[] = [];
    for (let i = 0; i < 26; i += 1)
      statuses.push((await send(url, report(s.gateId))).status);
    expect(statuses.filter((status) => status === 204)).toHaveLength(24);
    expect(statuses.at(-1)).toBe(429);
  });
});
