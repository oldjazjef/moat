import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ACCOUNT,
  ADMIN_ACCESS,
  ORG_ID,
  OWNER_ACCESS,
  VIEWER_ACCESS,
  choose,
  click,
  entry,
  member,
  openCloudPage,
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import type { MyAccess } from '../../../../core/auth/account.types';
import { MembersPage } from './members-page';

const ME = ACCOUNT.id;
const BOB = 'BOBBOBBOBBOBBOBBOBBOBB';
const EVE = 'EVEEVEEVEEVEEVEEVEEVEE';
const ROUTES = [
  { path: 'app/organisations/:orgId/members', component: MembersPage },
  { path: 'app/organisations/:orgId/projects', children: [] },
];
const MEMBERS = [
  member(ME, 'eme@example.ch', 'owner', true),
  member(BOB, 'bob@example.ch', 'editor', false),
  member(EVE, 'eve@example.ch', 'viewer', false),
];

const open = (access: MyAccess = OWNER_ACCESS) =>
  openCloudPage(`/app/organisations/${ORG_ID}/members`, ROUTES, {
    [`/api/orgs/${ORG_ID}`]: entry(access),
    [`/api/orgs/${ORG_ID}/members`]: { members: MEMBERS },
  });

/** The page reads the member list and the caller's access again after every change. */
async function answerReload(
  harness: Awaited<ReturnType<typeof open>>['harness'],
  members = MEMBERS,
  access: MyAccess = OWNER_ACCESS,
) {
  await new Promise((resolve) => setTimeout(resolve));
  // A reloading resource asks on the next change detection.
  harness.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(`/api/orgs/${ORG_ID}/members`).flush({ members });
  http.expectOne(`/api/orgs/${ORG_ID}`).flush(entry(access));
  await settle(harness);
}

const row = (el: HTMLElement, accountId: string) =>
  el.querySelector(`[data-account-id="${accountId}"]`) as HTMLElement;

describe('MembersPage (Mitglieder)', () => {
  afterEach(() => localStorage.clear());

  it('lists members with role and release, and shows the organisation and my role', async () => {
    const { el } = await open();
    expect(text(el, 'mt-page-header')).toContain('Muster AG');
    expect(text(el, '[data-my-role]')).toBe('Deine Rolle: Inhaber');
    expect(el.querySelectorAll('[data-member]').length).toBe(3);
    expect(text(row(el, BOB), '[data-email]')).toBe('bob@example.ch');
    expect(
      (row(el, BOB).querySelector('[data-role-select]') as HTMLSelectElement)
        .value,
    ).toBe('editor');
  });

  it('offers the release switch to Owners only, and only for roles that can hold it', async () => {
    const owner = await open(OWNER_ACCESS);
    expect(
      row(owner.el, BOB).querySelector('[data-release-toggle]'),
    ).not.toBeNull();
    // A viewer can never hold it: the status is text, there is no switch.
    expect(
      row(owner.el, EVE).querySelector('[data-release-toggle]'),
    ).toBeNull();
    expect(text(row(owner.el, EVE), '[data-release]')).toBe(
      'Darf nicht freigeben',
    );
    TestBed.resetTestingModule();
    const admin = await open(ADMIN_ACCESS);
    expect(admin.el.querySelector('[data-release-toggle]')).toBeNull();
    expect(admin.el.querySelector('[data-role-select]')).not.toBeNull();
  });

  it('a viewer sees the list only: no change, no removal, no form', async () => {
    const { el } = await open(VIEWER_ACCESS);
    expect(el.querySelectorAll('[data-member]').length).toBe(3);
    expect(el.querySelector('[data-role-select]')).toBeNull();
    expect(el.querySelector('[data-release-toggle]')).toBeNull();
    expect(el.querySelector('[data-action="remove"]')).toBeNull();
    expect(el.querySelector('[data-member-form]')).toBeNull();
    expect(text(row(el, BOB), '[data-role]')).toBe('Bearbeiter');
  });

  it('changes a role, then reads the list again', async () => {
    const { el, harness } = await open();
    choose(row(el, BOB), '[data-role-select]', 'admin');
    const request = await sent('PATCH', `/api/orgs/${ORG_ID}/members/${BOB}`);
    expect(request.request.body).toEqual({ role: 'admin' });
    request.flush({ member: { ...MEMBERS[1], role: 'admin' } });
    await answerReload(harness, [
      MEMBERS[0],
      { ...MEMBERS[1], role: 'admin' },
      MEMBERS[2],
    ]);
    expect(el.querySelector('[data-members-error]')).toBeNull();
  });

  it('sets the release permission', async () => {
    const { el, harness } = await open();
    const toggle = row(el, BOB).querySelector<HTMLInputElement>(
      '[data-release-toggle]',
    );
    if (!toggle) throw new Error('no switch');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const request = await sent('PATCH', `/api/orgs/${ORG_ID}/members/${BOB}`);
    expect(request.request.body).toEqual({ releaseGranted: true });
    request.flush({ member: { ...MEMBERS[1], releaseGranted: true } });
    await answerReload(harness);
  });

  it("shows the API's refusal with a translated text and puts the old role back", async () => {
    const { el, harness } = await open();
    choose(row(el, ME), '[data-role-select]', 'viewer');
    refuse(
      await sent('PATCH', `/api/orgs/${ORG_ID}/members/${ME}`),
      422,
      'last_owner',
    );
    await answerReload(harness);
    expect(text(el, '[data-members-error]')).toBe(
      'Die Organisation braucht mindestens einen Inhaber.',
    );
    expect(
      (row(el, ME).querySelector('[data-role-select]') as HTMLSelectElement)
        .value,
    ).toBe('owner');
  });

  it("shows a refused role (forbidden) the same way, never the server's words", async () => {
    const { el, harness } = await open(ADMIN_ACCESS);
    choose(row(el, BOB), '[data-role-select]', 'owner');
    refuse(
      await sent('PATCH', `/api/orgs/${ORG_ID}/members/${BOB}`),
      403,
      'forbidden',
    );
    await answerReload(harness, MEMBERS, ADMIN_ACCESS);
    expect(text(el, '[data-members-error]')).toBe(
      'Das darf deine Rolle nicht.',
    );
  });

  it('removes only after a second click in the same cell', async () => {
    const { el, harness } = await open();
    click(row(el, BOB), '[data-action="remove"]');
    await settle(harness);
    // Nothing was sent yet; the cell now asks again.
    expect(row(el, BOB).querySelector('[data-remove-confirm]')).not.toBeNull();
    click(row(el, BOB), '[data-remove-cancel]');
    await settle(harness);
    expect(row(el, BOB).querySelector('[data-remove-confirm]')).toBeNull();
    click(row(el, BOB), '[data-action="remove"]');
    await settle(harness);
    click(row(el, BOB), '[data-remove-confirm]');
    const request = await sent('DELETE', `/api/orgs/${ORG_ID}/members/${BOB}`);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await answerReload(harness, [MEMBERS[0], MEMBERS[2]]);
    expect(el.querySelectorAll('[data-member]').length).toBe(2);
  });

  it('adds by address and says only "if it exists" (T-79)', async () => {
    const { el, harness } = await open();
    typeInto(el, '#member-email', 'new@example.ch');
    choose(el, '#member-role', 'editor');
    submitForm(el, '[data-member-form]');
    const request = await sent('POST', `/api/orgs/${ORG_ID}/members`);
    expect(request.request.body).toEqual({
      email: 'new@example.ch',
      role: 'editor',
    });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await answerReload(harness);
    expect(text(el, '[data-add-sent]')).toContain(
      'Wenn zu dieser Adresse ein Konto gehört',
    );
    expect(text(el, '[data-add-sent]')).toContain(
      'sagt nicht, ob es die Adresse gibt',
    );
    expect((el.querySelector('#member-email') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('does not send a malformed address', async () => {
    const { el, harness } = await open();
    typeInto(el, '#member-email', 'nope');
    submitForm(el, '[data-member-form]');
    await settle(harness);
    expect(el.querySelector('[data-add-sent]')).toBeNull();
  });

  it('shows a foreign or unknown organisation as one plain "not found" (SEC-50)', async () => {
    const { el } = await openCloudPage(
      `/app/organisations/${ORG_ID}/members`,
      ROUTES,
      {
        [`/api/orgs/${ORG_ID}`]: { failStatus: 404 },
        [`/api/orgs/${ORG_ID}/members`]: { failStatus: 404 },
      },
    );
    expect(text(el, '[data-not-found]')).toContain('Nicht gefunden');
    expect(el.querySelector('[data-members]')).toBeNull();
  });
});
