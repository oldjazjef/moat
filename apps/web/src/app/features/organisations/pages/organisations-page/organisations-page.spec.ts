import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ActiveOrganisation } from '../../../../core/auth/active-organisation.service';
import {
  ADMIN_ACCESS,
  OTHER_ID,
  ORG_ID,
  OWNER_ACCESS,
  VIEWER_ACCESS,
  click,
  entry,
  openCloudPage,
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import { OrganisationsPage } from './organisations-page';

const ROUTES = [
  { path: 'app/organisations', component: OrganisationsPage },
  { path: 'app/organisations/:orgId/projects', children: [] },
];

const open = (list: unknown) =>
  openCloudPage('/app/organisations', ROUTES, { '/api/orgs': list });

describe('OrganisationsPage (Organisationen)', () => {
  afterEach(() => localStorage.clear());

  it('lists the organisations with the role and the release permission the API reported', async () => {
    const { el } = await open([
      entry(OWNER_ACCESS),
      {
        ...entry(VIEWER_ACCESS, OTHER_ID),
        organisation: {
          id: OTHER_ID,
          name: 'Beispiel GmbH',
          createdAt: '2026-10-15T08:00:00.000Z',
        },
      },
    ]);
    const rows = el.querySelectorAll('[data-organisation]');
    expect(rows.length).toBe(2);
    expect(text(rows[0] as HTMLElement, '[data-role]')).toBe('Inhaber');
    expect(text(rows[0] as HTMLElement, '[data-release]')).toBe('ja');
    expect(text(rows[1] as HTMLElement, '[data-role]')).toBe('Betrachter');
    expect(text(rows[1] as HTMLElement, '[data-release]')).toBe('nein');
    // Placed in the last cell as one plain button (list conventions).
    expect(
      (rows[0] as HTMLElement).querySelector(
        '.mt-actions-cell [data-action="open"]',
      ),
    ).not.toBeNull();
  });

  it('says so when there is no organisation yet, and offers to create one', async () => {
    const { el } = await open([]);
    expect(el.querySelector('[data-no-organisation]')).not.toBeNull();
    expect(el.querySelector('[data-organisation-form]')).not.toBeNull();
  });

  it('shows the list failure without any server text', async () => {
    const { el } = await openCloudPage('/app/organisations', ROUTES, {
      '/api/orgs': { failStatus: 500 },
    });
    expect(el.querySelector('[data-load-error]')).not.toBeNull();
  });

  it('switches: remembers the organisation for the sidebar and opens its projects', async () => {
    const { el, harness } = await open([entry(ADMIN_ACCESS)]);
    click(el, '[data-organisation] [data-action="open"]');
    await settle(harness);
    expect(TestBed.inject(ActiveOrganisation).id()).toBe(ORG_ID);
    expect(TestBed.inject(Router).url).toBe(
      `/app/organisations/${ORG_ID}/projects`,
    );
  });

  it('creates an organisation, then opens its projects', async () => {
    const { el, harness } = await open([]);
    typeInto(el, '#organisation-name', '  Muster AG  ');
    submitForm(el, '[data-organisation-form]');
    const request = await sent('POST', '/api/orgs');
    expect(request.request.body).toEqual({ name: 'Muster AG' });
    request.flush(entry(OWNER_ACCESS));
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe(
      `/app/organisations/${ORG_ID}/projects`,
    );
    expect(TestBed.inject(ActiveOrganisation).id()).toBe(ORG_ID);
  });

  it("does not send an empty name, and shows the API's refusal of a bad one", async () => {
    const { el, harness } = await open([]);
    submitForm(el, '[data-organisation-form]');
    await settle(harness);
    expect(el.querySelector('[data-create-error]')).toBeNull();
    typeInto(el, '#organisation-name', 'x');
    submitForm(el, '[data-organisation-form]');
    refuse(await sent('POST', '/api/orgs'), 422, 'name_invalid');
    await settle(harness);
    expect(text(el, '[data-create-error]')).toContain(
      'Dieser Name ist nicht möglich',
    );
  });
});
