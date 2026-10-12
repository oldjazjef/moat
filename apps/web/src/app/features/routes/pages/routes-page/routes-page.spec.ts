import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import {
  expectEdit,
  openProjectTab,
  PROJECT,
  settle,
} from '../../../../../testing/page-harness';
import { RoutesPage } from './routes-page';

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('RoutesPage', () => {
  it('shows each route as the gate enforces it, and the upstream with its secret by name', async () => {
    const { el } = await openProjectTab('routes', RoutesPage, PROJECT);
    const row = text(el, '[data-route-name="newsletter"]');
    expect(row).toContain('POST /newsletter');
    expect(row).toContain('https://api.hubapi.com/crm/v3/objects/contacts');
    expect(text(el, '[data-origins]')).toBe('https://www.example.ch');
    expect(text(el, '[data-rate-limit]')).toBe('5 pro 10 min je Besucher');
    expect(row).toContain('4 KiB');
    expect(text(el, '[data-upstream]')).toContain(
      'Bearer-Token aus Secret «hubspot-token»',
    );
  });

  it('sends to the overview when moat.yaml cannot be used', async () => {
    const { el } = await openProjectTab('routes', RoutesPage, {
      ...PROJECT,
      project: { config: { status: 'missing' }, gates: [] },
    });
    expect(el.querySelector('[data-config-unusable]')).not.toBeNull();
  });

  const type = (el: HTMLElement, selector: string, value: string) => {
    const field = el.querySelector(selector) as
      HTMLInputElement | HTMLTextAreaElement;
    field.value = value;
    field.dispatchEvent(new Event('input'));
  };
  const submit = (el: HTMLElement) =>
    (el.querySelector('[data-route-form]') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );

  it('adds a route from the form', async () => {
    const { el, harness } = await openProjectTab('routes', RoutesPage, PROJECT);
    (el.querySelector('[data-route-new]') as HTMLButtonElement).click();
    await settle(harness);
    type(el, '#route-name', 'contact');
    type(el, '#route-path', '/contact');
    type(el, '#route-upstream-path', '/crm/v3/objects/notes');
    type(el, '#route-origins', ' https://www.example.ch \n\n');
    submit(el);
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'addRoute',
      route: 'contact',
      definition: {
        method: 'POST',
        path: '/contact',
        upstream: 'hubspot',
        upstreamPath: '/crm/v3/objects/notes',
        origins: ['https://www.example.ch'],
      },
    });
    edit.flush(PROJECT);
    await settle(harness);
    expect(el.querySelector('[data-route-form]')).toBeNull();
    expect(text(el, '[data-edit-outcome="saved"]')).toContain(
      'In moat.yaml gespeichert.',
    );
  });

  it('does not send a route without a valid name and paths', async () => {
    const { el, harness } = await openProjectTab('routes', RoutesPage, PROJECT);
    (el.querySelector('[data-route-new]') as HTMLButtonElement).click();
    await settle(harness);
    type(el, '#route-name', 'Contact Form');
    type(el, '#route-path', 'contact');
    submit(el);
    await settle(harness);
    TestBed.inject(HttpTestingController).expectNone(
      `/api/projects/${PROJECT.id}/config/edits`,
    );
    expect(el.querySelector('#route-name')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(el.querySelector('#route-path')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('opens a route with its values in moat.yaml spelling and marks the fields the core refused', async () => {
    const { el, harness } = await openProjectTab('routes', RoutesPage, PROJECT);
    (el.querySelector('[data-route-edit]') as HTMLButtonElement).click();
    await settle(harness);
    const value = (selector: string) =>
      (el.querySelector(selector) as HTMLInputElement).value;
    expect(el.querySelector('#route-name')).toBeNull();
    expect(value('#route-path')).toBe('/newsletter');
    expect(value('#route-max-body')).toBe('4KiB');
    expect(value('#route-window')).toBe('10m');
    type(el, '#route-path', '/news/../admin');
    submit(el);
    const edit = expectEdit();
    expect(edit.request.body).toMatchObject({
      op: 'updateRoute',
      route: 'newsletter',
      definition: {
        path: '/news/../admin',
        maxBodySize: '4KiB',
        rateLimit: { requests: 5, window: '10m', per: 'ip' },
      },
    });
    edit.flush(
      { error: 'value_invalid', fields: ['path'] },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle(harness);
    expect(el.querySelector('[data-route-form]')).not.toBeNull();
    expect(el.querySelector('#route-path')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(
      el.querySelector('#route-upstream-path')?.getAttribute('aria-invalid'),
    ).not.toBe('true');
    expect(text(el, '[data-refused]')).toContain(
      'Moat hat die Route nicht gespeichert',
    );
  });

  it('switches a route off, and deletes it only on the second click', async () => {
    const { el, harness } = await openProjectTab('routes', RoutesPage, PROJECT);
    (el.querySelector('[data-route-disable]') as HTMLButtonElement).click();
    const off = expectEdit();
    expect(off.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'disableRoute',
      route: 'newsletter',
    });
    off.flush(PROJECT);
    await settle(harness);

    (el.querySelector('[data-route-remove]') as HTMLButtonElement).click();
    await settle(harness);
    TestBed.inject(HttpTestingController).expectNone(
      `/api/projects/${PROJECT.id}/config/edits`,
    );
    (
      el.querySelector('[data-route-remove-confirm]') as HTMLButtonElement
    ).click();
    const removed = expectEdit();
    expect(removed.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'removeRoute',
      route: 'newsletter',
    });
    removed.flush(PROJECT);
    await settle(harness);
  });

  const submitUpstream = (el: HTMLElement) =>
    (el.querySelector('[data-upstream-form]') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
  const choose = (el: HTMLElement, selector: string, value: string) => {
    const select = el.querySelector(selector) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };

  it('adds an upstream with a header and the secret by name only', async () => {
    const { el, harness } = await openProjectTab('routes', RoutesPage, PROJECT);
    (el.querySelector('[data-upstream-new]') as HTMLButtonElement).click();
    await settle(harness);
    type(el, '#upstream-name', 'mailchimp');
    type(el, '#upstream-origin', ' https://us21.api.mailchimp.com ');
    choose(el, '#upstream-auth', 'header');
    await settle(harness);
    submitUpstream(el);
    await settle(harness);
    // Header and secret are required for this auth type.
    TestBed.inject(HttpTestingController).expectNone(
      `/api/projects/${PROJECT.id}/config/edits`,
    );
    expect(
      el.querySelector('#upstream-header')?.getAttribute('aria-invalid'),
    ).toBe('true');
    type(el, '#upstream-header', 'X-Api-Key');
    type(el, '#upstream-secret', 'mailchimp-key');
    submitUpstream(el);
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'addUpstream',
      upstream: 'mailchimp',
      upstreamDefinition: {
        origin: 'https://us21.api.mailchimp.com',
        auth: { type: 'header', name: 'X-Api-Key', secret: 'mailchimp-key' },
      },
    });
    edit.flush(PROJECT);
    await settle(harness);
    expect(el.querySelector('[data-upstream-form]')).toBeNull();
  });

  it('opens an upstream with its values and marks the field the core refused', async () => {
    const { el, harness } = await openProjectTab('routes', RoutesPage, PROJECT);
    (el.querySelector('[data-upstream-edit]') as HTMLButtonElement).click();
    await settle(harness);
    const value = (selector: string) =>
      (el.querySelector(selector) as HTMLInputElement).value;
    expect(el.querySelector('#upstream-name')).toBeNull();
    expect(value('#upstream-origin')).toBe('https://api.hubapi.com');
    expect(value('#upstream-auth')).toBe('bearer');
    expect(value('#upstream-secret')).toBe('hubspot-token');
    expect(value('#upstream-timeout')).toBe('');
    type(el, '#upstream-origin', 'http://api.hubapi.com');
    submitUpstream(el);
    await settle(harness);
    // The form wants https:// before anything is sent (SEC-41).
    TestBed.inject(HttpTestingController).expectNone(
      `/api/projects/${PROJECT.id}/config/edits`,
    );
    type(el, '#upstream-origin', 'https://api.hubapi.com/crm');
    submitUpstream(el);
    const edit = expectEdit();
    expect(edit.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'updateUpstream',
      upstream: 'hubspot',
      upstreamDefinition: {
        origin: 'https://api.hubapi.com/crm',
        auth: { type: 'bearer', secret: 'hubspot-token' },
      },
    });
    edit.flush(
      { error: 'value_invalid', fields: ['origin'] },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle(harness);
    expect(
      el.querySelector('#upstream-origin')?.getAttribute('aria-invalid'),
    ).toBe('true');
    expect(text(el, '[data-refused]')).toContain(
      'Moat hat den Upstream nicht gespeichert',
    );
  });

  it('removes only an upstream no route calls, on the second click', async () => {
    const project = PROJECT.project;
    const config = project?.config;
    if (project == null || config?.status !== 'valid')
      throw new Error('fixture');
    const hubspot = config.config.upstreams['hubspot'];
    if (hubspot === undefined) throw new Error('fixture');
    const { el, harness } = await openProjectTab('routes', RoutesPage, {
      ...PROJECT,
      project: {
        ...project,
        config: {
          ...config,
          config: {
            ...config.config,
            upstreams: {
              ...config.config.upstreams,
              spare: { ...hubspot, auth: null },
            },
          },
        },
      },
    });
    const used = el.querySelector(
      '[data-upstream-name="hubspot"]',
    ) as HTMLElement;
    expect(used.querySelector('[data-upstream-remove]')).toBeNull();
    expect(text(used, '[data-upstream-callers]')).toBe(
      'Benutzt von newsletter',
    );
    const spare = el.querySelector(
      '[data-upstream-name="spare"]',
    ) as HTMLElement;
    (
      spare.querySelector('[data-upstream-remove]') as HTMLButtonElement
    ).click();
    await settle(harness);
    TestBed.inject(HttpTestingController).expectNone(
      `/api/projects/${PROJECT.id}/config/edits`,
    );
    (
      spare.querySelector('[data-upstream-remove-confirm]') as HTMLButtonElement
    ).click();
    const removed = expectEdit();
    expect(removed.request.body).toEqual({
      base: 'a'.repeat(64),
      op: 'removeUpstream',
      upstream: 'spare',
    });
    removed.flush(PROJECT);
    await settle(harness);
  });
});
