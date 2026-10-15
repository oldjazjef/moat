import { describe, expect, it } from 'vitest';
import {
  chainHistory,
  detailsValid,
  GENESIS_HASH,
  HistoryEventError,
  verifyHistory,
  type HistoryEvent,
  type HistoryRow,
} from './history';

/** A value the test has just built: its absence is the failure. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}

const AT = '2026-10-14T12:00:00.000Z';
const SHA = 'a'.repeat(64);

const EVENTS: HistoryEvent[] = [
  { kind: 'history_started', details: {} },
  {
    kind: 'bundle_signed',
    details: { gate: 'site', version: 1, sha256: SHA, kid: 'K'.repeat(22) },
  },
  {
    kind: 'secret_sealed',
    details: { gate: 'site', name: 'hubspot-token', secretVersion: 2 },
  },
  {
    kind: 'deploy',
    details: { gate: 'site', version: 1, target: 'sftp', sha256: SHA },
  },
  {
    kind: 'config_edited',
    details: { op: 'addRoute', before: SHA, after: 'b'.repeat(64) },
  },
  {
    kind: 'database_pushed',
    details: {
      key: 'shop',
      config: true,
      gates: 1,
      secrets: 1,
      bundles: 2,
      conflicts: 0,
    },
  },
];

async function chain(events = EVENTS): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [];
  for (const event of events)
    rows.push(await chainHistory(rows.at(-1) ?? null, AT, event));
  return rows;
}

describe('history hash chain', () => {
  it('chains rows: 1, 2, 3 …, each pointing at the previous hash', async () => {
    const rows = await chain();
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]?.prevHash).toBe(rows[i - 1]?.hash);
    expect(rows[1]?.details).toBe(
      `{"gate":"site","kid":"${'K'.repeat(22)}","sha256":"${SHA}","version":1}`,
    );
    const last = rows.at(-1) as HistoryRow;
    expect(
      await verifyHistory(rows, { seq: last.seq, hash: last.hash }),
    ).toEqual({ status: 'intact', entries: 6 });
  });

  it('detects a changed row as an attacker would edit the database (T-69)', async () => {
    const rows = await chain();
    const tampered = rows.map((row) =>
      row.seq === 3
        ? {
            ...row,
            details: row.details.replace(
              '"secretVersion":2',
              '"secretVersion":1',
            ),
          }
        : row,
    );
    expect(await verifyHistory(tampered, null)).toMatchObject({
      status: 'broken',
      seq: 3,
      reason: 'hash',
    });
  });

  it('detects a removed row, a reordered row and a recomputed row', async () => {
    const rows = await chain();
    expect(
      await verifyHistory([...rows.slice(0, 2), ...rows.slice(3)], null),
    ).toMatchObject({ status: 'broken', seq: 4, reason: 'sequence' });
    // Rewritten from row 3 on with valid hashes but without the anchor's knowledge.
    const forged = await chain([
      ...EVENTS.slice(0, 2),
      { kind: 'history_started', details: {} },
      ...EVENTS.slice(3),
    ]);
    const anchor = { seq: must(rows[5]).seq, hash: must(rows[5]).hash };
    expect(await verifyHistory(forged, anchor)).toMatchObject({
      status: 'broken',
      reason: 'anchor',
    });
    // A row whose prev points elsewhere.
    const relinked = rows.map((row) =>
      row.seq === 4 ? { ...row, prevHash: must(rows[0]).hash } : row,
    );
    expect(await verifyHistory(relinked, null)).toMatchObject({
      status: 'broken',
      seq: 4,
      reason: 'chain',
    });
  });

  it('detects a cut-off tail through the anchor', async () => {
    const rows = await chain();
    const anchor = { seq: 6, hash: must(rows[5]).hash };
    expect(await verifyHistory(rows.slice(0, 4), anchor)).toEqual({
      status: 'broken',
      entries: 4,
      seq: null,
      reason: 'anchor',
    });
    expect(await verifyHistory([], anchor)).toMatchObject({
      status: 'broken',
      reason: 'anchor',
    });
  });

  it('never records anything outside the closed list of details (no secret, no path)', async () => {
    const planted = 'sk-PLANTED-SECRET-0123456789';
    const bad: unknown[] = [
      { gate: 'site', name: 'hubspot-token', secretVersion: 1, value: planted },
      { gate: '../etc', name: 'x', secretVersion: 1 },
      { gate: 'site', name: planted, secretVersion: 1 },
    ];
    for (const details of bad) {
      expect(detailsValid('secret_sealed', details)).toBe(false);
      await expect(
        chainHistory(null, AT, {
          kind: 'secret_sealed',
          details: details as never,
        }),
      ).rejects.toBeInstanceOf(HistoryEventError);
    }
    expect(
      detailsValid('deploy', {
        gate: 'site',
        version: 1,
        target: '/home/me/upload',
        sha256: SHA,
      }),
    ).toBe(false);
    expect(detailsValid('unknown', {})).toBe(false);
    await expect(
      chainHistory(null, 'yesterday', must(EVENTS[0])),
    ).rejects.toBeInstanceOf(HistoryEventError);
  });

  it('refuses a row whose details are not in canonical form', async () => {
    const rows = await chain(EVENTS.slice(0, 2));
    const spaced = rows.map((row) =>
      row.seq === 2 ? { ...row, details: row.details.replace(':', ': ') } : row,
    );
    expect(await verifyHistory(spaced, null)).toMatchObject({
      status: 'broken',
      seq: 2,
      reason: 'details',
    });
  });
});
