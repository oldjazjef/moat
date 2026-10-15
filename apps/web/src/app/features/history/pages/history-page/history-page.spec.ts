import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  openPage,
  PROJECT,
  projectRoutes,
  settle,
} from '../../../../../testing/page-harness';
import type {
  HistoryCheck,
  HistoryView,
} from '../../../../core/api/history.types';
import type { DatabaseResult } from '../../../../core/desktop/desktop-bridge';
import { HistoryPage } from './history-page';

const BASE = `/api/projects/${PROJECT.id}`;
const HEX = (c: string) => c.repeat(64);
const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** Lets promises run without waiting for stability (an open request keeps the app unstable). */
const tick = async (harness: { detectChanges(): void }) => {
  await new Promise((resolve) => setTimeout(resolve));
  harness.detectChanges();
};
const click = (el: HTMLElement, selector: string) =>
  (el.querySelector(selector) as HTMLButtonElement).click();

const OFF: HistoryView = { enabled: false, entries: [] };
const ON: HistoryView = {
  enabled: true,
  entries: [
    {
      seq: 1,
      at: '2026-10-14T08:00:00.000Z',
      kind: 'history_started',
      details: {},
      hash: HEX('a'),
    },
    {
      seq: 2,
      at: '2026-10-14T08:05:00.000Z',
      kind: 'bundle_signed',
      details: {
        gate: 'site',
        version: 4,
        sha256: HEX('b'),
        kid: 'K'.repeat(22),
      },
      hash: HEX('c'),
    },
    {
      seq: 3,
      at: '2026-10-14T08:06:00.000Z',
      kind: 'deploy',
      details: { gate: 'site', version: 4, target: 'sftp', sha256: HEX('b') },
      hash: HEX('d'),
    },
  ],
};

const open = (view: HistoryView) =>
  openPage(`/app/projects/${PROJECT.id}/history`, projectRoutes(HistoryPage), {
    [BASE]: PROJECT,
    [`${BASE}/history`]: view,
  });

describe('HistoryPage (DT-03, «Verlauf»)', () => {
  afterEach(() => delete window.moatDesktop);

  it('offers to switch the history on and then shows its rows, newest first', async () => {
    const { el, harness } = await open(OFF);
    expect(el.querySelector('[data-history-table]')).toBeNull();
    click(el, '[data-history-enable]');
    const http = TestBed.inject(HttpTestingController);
    http.expectOne({ method: 'POST', url: `${BASE}/history` }).flush(ON);
    await tick(harness);
    http.expectOne({ method: 'GET', url: `${BASE}/history` }).flush(ON);
    await settle(harness);
    const rows = [...el.querySelectorAll('[data-history-row]')];
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'deploy',
      'bundle_signed',
      'history_started',
    ]);
    expect(rows[1]?.textContent).toContain('Bundle v4 für site signiert');
    expect(rows[1]?.textContent).toContain('bbbbbbbbbbbb…');
    // Never the whole digest: the table shows the first twelve characters.
    expect(rows[1]?.textContent).not.toContain(HEX('b'));
    expect(rows[0]?.textContent).toContain('SFTP');
  });

  it('shows what «Prüfen» found: intact, or where the chain breaks', async () => {
    const { el, harness } = await open(ON);
    const http = TestBed.inject(HttpTestingController);
    click(el, '[data-history-verify]');
    http
      .expectOne({ method: 'POST', url: `${BASE}/history/verify` })
      .flush({ status: 'intact', entries: 3 } satisfies HistoryCheck);
    await settle(harness);
    expect(text(el, '[data-history-intact]')).toContain('3 Einträge');

    click(el, '[data-history-verify]');
    http.expectOne({ method: 'POST', url: `${BASE}/history/verify` }).flush({
      status: 'broken',
      entries: 3,
      seq: 2,
      reason: 'hash',
    } satisfies HistoryCheck);
    await settle(harness);
    expect(el.querySelector('[data-history-intact]')).toBeNull();
    expect(text(el, '[data-history-broken]')).toBe(
      'Ab Eintrag 2 passt der Verlauf nicht mehr. Ein Eintrag wurde nachträglich verändert.',
    );
  });

  it('shows a failure without details', async () => {
    const { el, harness } = await open(OFF);
    click(el, '[data-history-enable]');
    TestBed.inject(HttpTestingController)
      .expectOne(`${BASE}/history`)
      .flush(null, { status: 500, statusText: 'Error' });
    await settle(harness);
    expect(text(el, '[data-history-notice]')).toContain('nicht geklappt');
  });

  it('offers the external database only in the desktop, and re-reads the project after it', async () => {
    const browser = await open(ON);
    expect(browser.el.querySelector('[data-history-database]')).toBeNull();
    TestBed.resetTestingModule();

    const result: DatabaseResult = {
      status: 'done',
      direction: 'pull',
      config: true,
      gates: 1,
      secrets: 2,
      bundles: 3,
      issues: 1,
    };
    const databaseOpen = vi.fn().mockResolvedValue(result);
    window.moatDesktop = {
      platform: 'linux',
      project: { add: vi.fn(), create: vi.fn(), reveal: vi.fn() },
      key: { status: vi.fn(), choose: vi.fn(), create: vi.fn() },
      bundle: { sign: vi.fn() },
      secret: { seal: vi.fn() },
      gate: { deploy: vi.fn() },
      database: { open: databaseOpen },
    };
    const { el, harness } = await open(ON);
    click(el, '[data-history-database-open]');
    await tick(harness);
    expect(databaseOpen).toHaveBeenCalledWith(PROJECT.id, 'de-CH');
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(BASE).flush(PROJECT);
    http.expectOne(`${BASE}/history`).flush(ON);
    await settle(harness);
    expect(text(el, '[data-history-database-result]')).toBe(
      'Aus der Datenbank geholt: 1 Gates, 2 Secrets, 3 Bundles. 1 Mal nichts überschrieben, siehe Fenster.',
    );
  });
});
