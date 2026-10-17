import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  AuditEventError,
  chainAudit,
  eventValid,
  verifyAudit,
  type AuditEvent,
  type AuditRow,
} from './audit-log';

const ORG = 'O'.repeat(22);
const OTHER = 'P'.repeat(22);
const ME = 'A'.repeat(22);
const TARGET = 'T'.repeat(22);
const AT = '2026-10-17T12:00:00.000Z';
const SHA = 'a'.repeat(64);

const EVENTS: AuditEvent[] = [
  { action: 'org.create', target: ORG, details: {} },
  {
    action: 'member.add_requested',
    target: null,
    details: { role: 'editor', emailHash: SHA },
  },
  {
    action: 'member.change',
    target: TARGET,
    details: {
      fromRole: 'editor',
      toRole: 'admin',
      fromRelease: false,
      toRelease: true,
    },
  },
  {
    action: 'member.remove',
    target: TARGET,
    details: { role: 'admin', self: false },
  },
  { action: 'project.create', target: TARGET, details: {} },
  { action: 'project.delete', target: TARGET, details: {} },
  { action: 'config.edit', target: TARGET, details: { op: 'addRoute' } },
  {
    action: 'gate.add',
    target: TARGET,
    details: { gate: 'site', mode: 'managed' },
  },
  { action: 'gate.pull_token', target: TARGET, details: { gate: 'site' } },
  {
    action: 'secret.set',
    target: TARGET,
    details: { gate: 'site', name: 'hubspot-token', secretVersion: 2 },
  },
  {
    action: 'bundle.sign',
    target: TARGET,
    details: { gate: 'site', version: 3, sha256: SHA, kid: 'K'.repeat(22) },
  },
  {
    action: 'bundle.upload',
    target: TARGET,
    details: { gate: 'site', version: 4, sha256: SHA, kid: 'K'.repeat(22) },
  },
];

async function build(org = ORG): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  for (const event of EVENTS) {
    const last = rows.at(-1) ?? null;
    rows.push(await chainAudit(last, org, AT, ME, event));
  }
  return rows;
}

describe('audit log chain (SEC-53)', () => {
  it('chains every action from the genesis hash and verifies', async () => {
    const rows = await build();
    expect(rows.map((r) => r.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(rows[0]?.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(await verifyAudit(ORG, rows, null)).toEqual({
      status: 'intact',
      entries: 12,
    });
    const last = rows.at(-1);
    expect(
      await verifyAudit(ORG, rows, { seq: 12, hash: last?.hash ?? '' }),
    ).toMatchObject({ status: 'intact' });
  });

  it('is deterministic', async () => {
    expect(await build()).toEqual(await build());
  });

  it('detects a changed row, a removed row, an inserted row and a reordered pair', async () => {
    const rows = await build();
    const edited = rows.map((r) =>
      r.seq === 3 ? { ...r, details: r.details.replace('admin', 'owner') } : r,
    );
    expect(await verifyAudit(ORG, edited, null)).toMatchObject({
      status: 'broken',
      seq: 3,
    });
    expect(
      await verifyAudit(
        ORG,
        rows.filter((r) => r.seq !== 2),
        null,
      ),
    ).toMatchObject({ status: 'broken', seq: 3, reason: 'sequence' });
    const actorChanged = rows.map((r) =>
      r.seq === 4 ? { ...r, actor: 'B'.repeat(22) } : r,
    );
    expect(await verifyAudit(ORG, actorChanged, null)).toMatchObject({
      status: 'broken',
      seq: 4,
      reason: 'hash',
    });
    const [a, b, ...rest] = rows;
    expect(
      await verifyAudit(
        ORG,
        [b, a, ...rest].filter(Boolean) as AuditRow[],
        null,
      ),
    ).toMatchObject({ status: 'broken', seq: 2 });
  });

  it('a rewritten chain with valid hashes still fails against the head, and a cut tail too', async () => {
    const rows = await build();
    const head = { seq: 12, hash: rows[11]?.hash ?? '' };
    expect(await verifyAudit(ORG, rows.slice(0, 4), head)).toMatchObject({
      status: 'broken',
      seq: null,
      reason: 'head',
    });
    const forged: AuditRow[] = [];
    for (const event of EVENTS)
      forged.push(
        await chainAudit(
          forged.at(-1) ?? null,
          ORG,
          '2026-10-18T00:00:00.000Z',
          ME,
          event,
        ),
      );
    expect(await verifyAudit(ORG, forged, head)).toMatchObject({
      status: 'broken',
      reason: 'head',
    });
  });

  it('refuses a row moved into another organisation (T-87)', async () => {
    const rows = await build(OTHER);
    expect(await verifyAudit(ORG, rows, null)).toMatchObject({
      status: 'broken',
      seq: 1,
      reason: 'organisation',
    });
    const relabelled = rows.map((r) => ({ ...r, organisationId: ORG }));
    expect(await verifyAudit(ORG, relabelled, null)).toMatchObject({
      status: 'broken',
      seq: 1,
      reason: 'hash',
    });
  });

  it('records only the closed details: free text, extra keys, a wrong target are refused', async () => {
    const bad: [string, string | null, unknown][] = [
      ['project.create', TARGET, { name: 'secret plan' }],
      ['project.create', null, {}],
      ['project.create', 'short', {}],
      ['member.add_requested', null, { role: 'editor', email: 'a@b.ch' }],
      ['member.add_requested', null, { role: 'root', emailHash: SHA }],
      ['member.add_requested', null, { role: 'editor', emailHash: 'A@B.CH' }],
      ['member.add_requested', TARGET, { role: 'editor', emailHash: SHA }],
      ['member.remove', TARGET, { role: 'admin', self: 'no' }],
      ['member.change', TARGET, { fromRole: 'viewer', toRole: 'viewer' }],
      ['unknown.action', null, {}],
      ['config.edit', TARGET, { op: 'add route' }],
      ['config.edit', TARGET, { op: 'addRoute', value: 'x' }],
      ['gate.add', TARGET, { gate: 'Site', mode: 'managed' }],
      ['gate.add', TARGET, { gate: 'site', mode: 'cloud' }],
      ['gate.pull_token', TARGET, { gate: 'site', token: 'abc' }],
      ['secret.set', TARGET, { gate: 'site', name: 'x', secretVersion: 0 }],
      [
        'secret.set',
        TARGET,
        { gate: 'site', name: 'x', secretVersion: 1, ct: 'abc' },
      ],
      [
        'bundle.sign',
        TARGET,
        { gate: 'site', version: 1, sha256: 'zz', kid: 'K'.repeat(22) },
      ],
      [
        'bundle.upload',
        TARGET,
        { gate: 'site', version: 1, sha256: SHA, kid: 'short' },
      ],
    ];
    for (const [action, target, details] of bad)
      expect(eventValid(action, target, details), action).toBe(false);
    await expect(
      chainAudit(null, ORG, AT, ME, {
        action: 'project.create',
        target: TARGET,
        details: { name: 'x' } as never,
      }),
    ).rejects.toBeInstanceOf(AuditEventError);
    await expect(
      chainAudit(null, ORG, 'yesterday', ME, EVENTS[0] as AuditEvent),
    ).rejects.toThrow('time');
  });
});
