import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Routes } from '@angular/router';
import type { RouterTestingHarness } from '@angular/router/testing';
import { AccountSession } from '../app/core/auth/account-session.service';
import type {
  AccountView,
  MemberView,
  MyAccess,
  OrganisationEntry,
} from '../app/core/auth/account.types';
import { openPage, settle } from './page-harness';

export const ACCOUNT: AccountView = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  email: 'eme@example.ch',
  totpEnabled: false,
  passkeyCount: 0,
  createdAt: '2026-10-15T08:00:00.000Z',
};
export const CSRF = 'csrf-token-of-the-session';
export const ORG_ID = 'OOOOOOOOOOOOOOOOOOOOOO';
export const OTHER_ID = 'BBBBBBBBBBBBBBBBBBBBBB';

export const OWNER_ACCESS: MyAccess = {
  role: 'owner',
  releaseGranted: true,
  permissions: [
    'org:read',
    'members:read',
    'members:manage',
    'release:grant',
    'project:read',
    'project:create',
    'project:delete',
    'billing:manage',
    'audit:read',
    'config:read',
    'config:write',
    'gate:manage',
    'secret:write',
    'release',
  ],
};
export const ADMIN_ACCESS: MyAccess = {
  role: 'admin',
  releaseGranted: false,
  permissions: [
    'org:read',
    'members:read',
    'members:manage',
    'project:read',
    'project:create',
    'project:delete',
    'audit:read',
    'config:read',
    'config:write',
    'gate:manage',
    'secret:write',
  ],
};
export const VIEWER_ACCESS: MyAccess = {
  role: 'viewer',
  releaseGranted: false,
  permissions: ['org:read', 'members:read', 'project:read', 'config:read'],
};

export const entry = (access: MyAccess, id = ORG_ID): OrganisationEntry => ({
  organisation: {
    id,
    name: 'Muster AG',
    createdAt: '2026-10-15T08:00:00.000Z',
  },
  access,
});

export const member = (
  accountId: string,
  email: string,
  role: MemberView['role'],
  releaseGranted = false,
): MemberView => ({
  accountId,
  email,
  role,
  releaseGranted,
  createdAt: '2026-10-15T08:00:00.000Z',
});

/**
 * Opens a Cloud page with a signed-in account (`GET /api/auth/me` answers) and the given API
 * answers. Signed-out specs pass `signedIn: false`.
 */
export function openCloudPage(
  url: string,
  routes: Routes,
  answers: Readonly<Record<string, unknown>>,
) {
  return openPage(
    url,
    routes,
    { '/api/auth/me': { account: ACCOUNT, csrfToken: CSRF }, ...answers },
    () => void TestBed.inject(AccountSession).load(),
  );
}

/** Types into an input as a person would. */
export function typeInto(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

export function choose(el: HTMLElement, selector: string, value: string) {
  const select = el.querySelector<HTMLSelectElement>(selector);
  if (!select) throw new Error(`no select ${selector}`);
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

export function submitForm(el: HTMLElement, selector: string) {
  const form = el.querySelector<HTMLFormElement>(selector);
  if (!form) throw new Error(`no form ${selector}`);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

export function click(el: HTMLElement, selector: string) {
  const button = el.querySelector<HTMLElement>(selector);
  if (!button) throw new Error(`no element ${selector}`);
  button.click();
}

export const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** The request the page just sent (after a macrotask), to check and answer. */
export async function sent(method: string, url: string) {
  await new Promise((resolve) => setTimeout(resolve));
  const request = TestBed.inject(HttpTestingController).expectOne(url);
  expect(request.request.method).toBe(method);
  return request;
}

/** Answers with the API's uniform error body. */
export function refuse(
  request: ReturnType<HttpTestingController['expectOne']>,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
) {
  request.flush(
    { statusCode: status, error, ...extra },
    { status, statusText: 'Error' },
  );
}

export { settle };
export type { RouterTestingHarness };
