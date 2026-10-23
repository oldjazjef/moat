import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ADMIN_ACCESS,
  ORG_ID,
  VIEWER_ACCESS,
  click,
  entry,
  openCloudPage,
  sent,
  settle,
  text,
} from '../../../../../testing/cloud-harness';
import type { MyAccess } from '../../../../core/auth/account.types';
import { AuditPage } from './audit-page';

const ROUTES = [
  { path: 'app/organisations/:orgId/audit', component: AuditPage },
  { path: 'app/organisations/:orgId/projects', children: [] },
  { path: 'app/organisations/:orgId/members', children: [] },
];
const ROW = (seq: number) => ({
  seq,
  at: '2026-10-17T09:30:00.000Z',
  actor: 'ACTORACTORACTORACTORAC',
  action: 'member.change',
  target: 'TARGETTARGETTARGETTARGE',
  details:
    '{"fromRelease":false,"fromRole":"viewer","toRelease":false,"toRole":"editor"}',
  hash: 'a'.repeat(64),
});
const URL_ = `/api/orgs/${ORG_ID}/audit?after=0&limit=50`;

const open = (access: MyAccess, audit: unknown) =>
  openCloudPage(`/app/organisations/${ORG_ID}/audit`, ROUTES, {
    [`/api/orgs/${ORG_ID}`]: entry(access),
    ...(audit === undefined ? {} : { [URL_]: audit }),
  });

describe('AuditPage (Protokoll)', () => {
  afterEach(() => localStorage.clear());

  it('lists the entries with action, time and the closed details', async () => {
    const { el } = await open(ADMIN_ACCESS, {
      entries: [ROW(1), ROW(2)],
      next: null,
    });
    expect(el.querySelectorAll('[data-audit-entry]').length).toBe(2);
    const first = el.querySelector('[data-audit-entry]') as HTMLElement;
    expect(text(first, '[data-action]')).toBe('Mitglied geändert');
    expect(text(first, '[data-at]')).toBe('2026-10-17 09:30:00');
    expect(text(first, '[data-details]')).toContain('toRole: editor');
    expect(el.querySelector('[data-audit-more]')).toBeNull();
  });

  it('continues with `next` when more entries exist', async () => {
    const { harness, el } = await open(ADMIN_ACCESS, {
      entries: [ROW(1)],
      next: 1,
    });
    click(el, '[data-audit-more]');
    const request = await sent(
      'GET',
      `/api/orgs/${ORG_ID}/audit?after=1&limit=50`,
    );
    request.flush({ entries: [ROW(2)], next: null });
    await settle(harness);
    expect(el.querySelectorAll('[data-audit-entry]').length).toBe(2);
    expect(el.querySelector('[data-audit-more]')).toBeNull();
  });

  it('does not ask for the log when the role may not read it', async () => {
    const { el } = await open(VIEWER_ACCESS, undefined);
    TestBed.inject(HttpTestingController).expectNone(URL_);
    expect(el.querySelector('[data-audit-forbidden]')).not.toBeNull();
    expect(el.querySelector('[data-audit]')).toBeNull();
  });

  it('shows an intact chain with the head to write down', async () => {
    const { harness, el } = await open(ADMIN_ACCESS, {
      entries: [ROW(1)],
      next: null,
    });
    click(el, '[data-audit-verify]');
    const request = await sent('GET', `/api/orgs/${ORG_ID}/audit/verify`);
    request.flush({
      check: { status: 'intact', entries: 1 },
      head: { seq: 1, hash: 'a'.repeat(64) },
    });
    await settle(harness);
    expect(text(el, '[data-audit-intact]')).toBe(
      'Die Kette ist unversehrt: 1 Einträge.',
    );
    expect(text(el, '[data-audit-head]')).toContain('a'.repeat(64));
  });

  it('says why a broken chain is broken', async () => {
    const { harness, el } = await open(ADMIN_ACCESS, {
      entries: [ROW(1)],
      next: null,
    });
    click(el, '[data-audit-verify]');
    const request = await sent('GET', `/api/orgs/${ORG_ID}/audit/verify`);
    request.flush({
      check: { status: 'broken', entries: 1, seq: 1, reason: 'hash' },
      head: null,
    });
    await settle(harness);
    expect(text(el, '[data-audit-broken]')).toContain(
      'Ein Eintrag passt nicht mehr zu seinem Hash.',
    );
  });

  it('shows a translated text for a refused read, never the API words', async () => {
    const { el } = await open(ADMIN_ACCESS, { failStatus: 403 });
    expect(el.querySelector('[data-audit-error]')).not.toBeNull();
  });

  it('offers the exports as downloads from the API', async () => {
    const { el } = await open(ADMIN_ACCESS, { entries: [], next: null });
    expect(
      el.querySelector('[data-audit-export-csv]')?.getAttribute('href'),
    ).toBe(`/api/orgs/${ORG_ID}/audit/export?format=csv`);
    expect(el.querySelector('[data-audit-empty]')).not.toBeNull();
  });
});
