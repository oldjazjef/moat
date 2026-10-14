import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  openProjectTab,
  PROJECT,
  settle,
} from '../../../../../testing/page-harness';
import type { DryRunResult } from '../../../../core/api/dry-run.types';
import { ConsolePage } from './console-page';

const ENDPOINT = `/api/projects/${PROJECT.id}/dry-run`;
const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const pick = (el: HTMLElement, selector: string, value: string) => {
  const field = el.querySelector(selector) as HTMLSelectElement;
  field.value = value;
  field.dispatchEvent(new Event('change'));
};
const submit = (el: HTMLElement) =>
  (el.querySelector('[data-console-form]') as HTMLFormElement).dispatchEvent(
    new Event('submit'),
  );

const FORWARDED: DryRunResult = {
  kind: 'forwarded',
  route: 'newsletter',
  call: {
    method: 'POST',
    url: 'https://api.hubapi.com/crm/v3/objects/contacts',
    headers: [
      ['Accept', 'application/json'],
      ['Content-Type', 'application/json'],
      ['Authorization', 'Bearer <SECRET>'],
      ['User-Agent', 'moat-gate'],
    ],
    body: '{}',
    timeoutMs: 10_000,
    secret: 'hubspot-token',
  },
  headers: {
    'Access-Control-Allow-Origin': 'https://www.example.ch',
    Vary: 'Origin',
  },
  counters: [
    { kind: 'perIp', requests: 30, per: 60 },
    { kind: 'routeQuota', requests: 500, per: 'day' },
  ],
  budgets: [],
  estimate: null,
};

describe('ConsolePage (FR-42)', () => {
  it('starts from a route, sends the request to the dry run and shows the call the gate would make', async () => {
    const { el, harness } = await openProjectTab(
      'console',
      ConsolePage,
      PROJECT,
    );
    pick(el, '[data-console-route]', 'newsletter');
    pick(el, '[data-console-gate]', 'site');
    await settle(harness);
    expect(
      (el.querySelector('[data-console-path]') as HTMLInputElement).value,
    ).toBe('/newsletter');
    submit(el);
    const request = TestBed.inject(HttpTestingController).expectOne(ENDPOINT);
    expect(request.request.body).toEqual({
      gate: 'site',
      method: 'POST',
      path: '/newsletter',
      origin: 'https://www.example.ch',
      contentType: 'application/json',
      requestMethod: null,
      body: '{}',
    });
    request.flush(FORWARDED);
    await settle(harness);
    expect(text(el, '[data-console-call]')).toContain(
      'POST https://api.hubapi.com/crm/v3/objects/contacts',
    );
    expect(text(el, '[data-console-call]')).toContain(
      'Authorization: Bearer <SECRET>',
    );
    expect(text(el, '[data-console-secret]')).toContain('«hubspot-token»');
    expect(text(el, '[data-console-counters]')).toContain(
      'höchstens 500 Anfragen pro Tag (Route)',
    );
    expect(text(el, '[data-console-headers]')).toContain(
      'Access-Control-Allow-Origin: https://www.example.ch',
    );
  });

  it('explains a refusal with its status and code', async () => {
    const { el, harness } = await openProjectTab(
      'console',
      ConsolePage,
      PROJECT,
    );
    submit(el);
    TestBed.inject(HttpTestingController)
      .expectOne(ENDPOINT)
      .flush({
        kind: 'refused',
        status: 415,
        error: 'unsupported_media_type',
        route: 'newsletter',
        headers: {},
      } satisfies DryRunResult);
    await settle(harness);
    expect(text(el, '[data-console-status]')).toBe('415');
    expect(text(el, '[data-console-explain]')).toBe(
      'Dieser Content-Type ist für die Route nicht erlaubt.',
    );
  });

  it('says why nothing could be checked', async () => {
    const { el, harness } = await openProjectTab(
      'console',
      ConsolePage,
      PROJECT,
    );
    submit(el);
    TestBed.inject(HttpTestingController)
      .expectOne(ENDPOINT)
      .flush({ error: 'gate_unknown' }, { status: 422, statusText: 'x' });
    await settle(harness);
    expect(text(el, '[data-console-notice]')).toContain('Lade das Projekt neu');
  });

  it('sends to the overview when moat.yaml cannot be used', async () => {
    const { el } = await openProjectTab('console', ConsolePage, {
      ...PROJECT,
      project: { config: { status: 'missing' }, gates: [] },
    });
    expect(el.querySelector('[data-config-unusable]')).not.toBeNull();
  });
});
