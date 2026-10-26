import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  PasskeyBrowser,
  PasskeyBrowserError,
  type PasskeyProblem,
} from '../../../../core/auth/passkey-browser';
import { openPage } from '../../../../../testing/page-harness';
import {
  ACCOUNT,
  CSRF,
  click,
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import { AccountPage } from '../../pages/account-page/account-page';

const PASSWORD = 'planted-current-password';
const ROUTES = [{ path: 'app/account', component: AccountPage }];
const KEY = {
  id: 'KKKKKKKKKKKKKKKKKKKKKK',
  name: 'Laptop',
  createdAt: '2026-10-20T08:00:00.000Z',
  lastUsedAt: null,
};
const OPTIONS = {
  challenge: 'Y2hhbGxlbmdl',
  rp: { id: 'moat.example.ch', name: 'Moat' },
  user: { id: 'dXNlcg', name: 'eme@example.ch', displayName: 'eme@example.ch' },
  excludeCredentials: [],
  timeoutMs: 120000,
};
const CREATED = { attestationObject: 'YXR0', clientDataJSON: 'Y2xpZW50' };

interface Stub {
  readonly create?: () => Promise<unknown>;
  readonly supported?: boolean;
}

const open = (passkeys: unknown[] = [], stub: Stub = {}) =>
  openPage(
    '/app/account',
    ROUTES,
    {
      '/api/auth/me': { account: ACCOUNT, csrfToken: CSRF },
      '/api/auth/passkeys': { passkeys },
    },
    () => {
      const browser = TestBed.inject(PasskeyBrowser);
      vi.spyOn(browser, 'supported', 'get').mockReturnValue(
        stub.supported ?? true,
      );
      vi.spyOn(browser, 'create').mockImplementation(
        (stub.create ?? (() => Promise.resolve(CREATED))) as never,
      );
      void TestBed.inject(AccountSession).load();
    },
  );

function fillAdd(el: HTMLElement, name = 'Laptop') {
  typeInto(el, '#passkey-name', name);
  typeInto(el, '#passkey-password', PASSWORD);
  submitForm(el, '[data-passkey-add-form]');
}

describe('Passkeys on the account page (SEC-51)', () => {
  it('lists the passkeys by name and date, and nothing else', async () => {
    const { el } = await open([KEY]);
    expect(text(el, '[data-passkey-name]')).toBe('Laptop');
    expect(text(el, '[data-passkey]')).toContain('noch nie benutzt');
    expect(text(el, '[data-passkey]')).toContain('2026-10-20');
    expect(TestBed.inject(AccountSession).account()?.passkeyCount).toBe(1);
  });

  it('says so when there is none', async () => {
    const { el } = await open([]);
    expect(el.querySelector('[data-passkeys-empty]')).not.toBeNull();
  });

  it('adds one: password, challenge, the browser makes the key, Moat Cloud stores it', async () => {
    const { el, harness } = await open([]);
    fillAdd(el);
    const options = await sent('POST', '/api/auth/passkeys/options');
    expect(options.request.body).toEqual({ password: PASSWORD });
    options.flush(OPTIONS);
    const created = await sent('POST', '/api/auth/passkeys');
    expect(created.request.body).toEqual({ name: 'Laptop', ...CREATED });
    created.flush({ passkey: KEY }, { status: 201, statusText: 'Created' });
    await settle(harness);
    (await sent('GET', '/api/auth/passkeys')).flush({ passkeys: [KEY] });
    await settle(harness);
    expect(el.querySelector('[data-passkey-added]')).not.toBeNull();
    expect(text(el, '[data-passkey-name]')).toBe('Laptop');
    expect(
      (el.querySelector('#passkey-password') as HTMLInputElement).value,
    ).toBe('');
  });

  it('sends nothing without a name and a password', async () => {
    const { el, harness } = await open([]);
    submitForm(el, '[data-passkey-add-form]');
    await settle(harness);
    TestBed.inject(HttpTestingController).expectNone(
      '/api/auth/passkeys/options',
    );
    expect(el.querySelector('[data-passkey-added]')).toBeNull();
  });

  it("shows the API's refusal of the password as a translated text", async () => {
    const { el, harness } = await open([]);
    fillAdd(el);
    refuse(
      await sent('POST', '/api/auth/passkeys/options'),
      401,
      'invalid_credentials',
    );
    await settle(harness);
    expect(el.querySelector('[data-passkeys-error]')).not.toBeNull();
  });

  it.each<PasskeyProblem>(['cancelled', 'failed'])(
    'says so when the browser side ends in %s, and stores nothing',
    async (problem) => {
      const { el, harness } = await open([], {
        create: () => Promise.reject(new PasskeyBrowserError(problem)),
      });
      fillAdd(el);
      (await sent('POST', '/api/auth/passkeys/options')).flush(OPTIONS);
      await settle(harness);
      expect(el.querySelector('[data-passkeys-problem]')).not.toBeNull();
      expect(el.querySelector('[data-passkey-added]')).toBeNull();
    },
  );

  it('offers no form in a browser without passkeys', async () => {
    const { el } = await open([], { supported: false });
    expect(el.querySelector('[data-passkeys-unsupported]')).not.toBeNull();
    expect(el.querySelector('[data-passkey-add-form]')).toBeNull();
  });

  it('removes only after the password, then reads the list again', async () => {
    const { el, harness } = await open([KEY]);
    click(el, '[data-passkey-remove]');
    harness.detectChanges();
    typeInto(el, '#passkey-remove-password', PASSWORD);
    submitForm(el, '[data-passkey-remove-form]');
    const request = await sent('POST', `/api/auth/passkeys/${KEY.id}/remove`);
    expect(request.request.body).toEqual({ password: PASSWORD });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await settle(harness);
    (await sent('GET', '/api/auth/passkeys')).flush({ passkeys: [] });
    await settle(harness);
    expect(el.querySelector('[data-passkey]')).toBeNull();
    expect(TestBed.inject(AccountSession).account()?.passkeyCount).toBe(0);
  });

  it('cancelling the removal asks nothing', async () => {
    const { el, harness } = await open([KEY]);
    click(el, '[data-passkey-remove]');
    harness.detectChanges();
    click(el, '[data-passkey-remove-cancel]');
    harness.detectChanges();
    expect(el.querySelector('[data-passkey-remove-form]')).toBeNull();
  });
});
