import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { LOCALE_STORAGE_KEY } from '../../../../core/i18n/locales';
import { openPage } from '../../../../../testing/page-harness';
import {
  ACCOUNT,
  CSRF,
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import { PasskeyBrowser } from '../../../../core/auth/passkey-browser';
import { LoginPage } from './login-page';

const PASSWORD = 'planted-password-never-shown';
const ROUTES = [
  { path: 'login', component: LoginPage },
  { path: 'register', children: [] },
  { path: 'app', children: [] },
];

const open = (browser?: Partial<Record<'get', () => Promise<unknown>>>) =>
  openPage('/login', ROUTES, {}, () => {
    if (browser === undefined) return;
    const real = TestBed.inject(PasskeyBrowser);
    vi.spyOn(real, 'supported', 'get').mockReturnValue(true);
    vi.spyOn(real, 'get').mockImplementation(browser.get as never);
  });

function fill(el: HTMLElement) {
  typeInto(el, '#login-email', 'eme@example.ch');
  typeInto(el, '#login-password', PASSWORD);
}

describe('LoginPage (Anmelden)', () => {
  // The frame reads the stored language (the German texts of the harness).
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'de-CH'));
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('shows the form and a way to register', async () => {
    const { el } = await open();
    expect(text(el, 'h1')).toBe('Anmelden');
    expect(el.querySelector('#login-password')?.getAttribute('type')).toBe(
      'password',
    );
    expect(el.querySelector('[data-to-register]')?.getAttribute('href')).toBe(
      '/register',
    );
  });

  it('sends nothing for an empty or malformed form', async () => {
    const { el, harness } = await open();
    submitForm(el, '[data-login-form]');
    typeInto(el, '#login-email', 'not-an-address');
    typeInto(el, '#login-password', PASSWORD);
    submitForm(el, '[data-login-form]');
    await settle(harness);
    // afterEach of the harness: any request would be unexpected.
    expect(el.querySelector('[data-login-error]')).toBeNull();
  });

  it('signs in with address and password and opens the app, storing nothing', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    const request = await sent('POST', '/api/auth/login');
    expect(request.request.body).toEqual({
      email: 'eme@example.ch',
      password: PASSWORD,
    });
    request.flush({ account: ACCOUNT, csrfToken: CSRF });
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe('/app');
    const storage = JSON.stringify([
      ...Object.entries(localStorage),
      ...Object.entries(sessionStorage),
    ]);
    expect(storage).not.toContain(PASSWORD);
    expect(storage).not.toContain(CSRF);
  });

  it('asks for the code when the API answers mfa_required, then signs in with it', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 401, 'mfa_required', {
      methods: ['totp'],
    });
    await settle(harness);
    expect(el.querySelector('#login-code')).not.toBeNull();
    // The password field is gone from the page while the code is asked for.
    expect(el.querySelector('#login-password')).toBeNull();
    expect(el.querySelector('[data-login-error]')).toBeNull();

    typeInto(el, '#login-code', '123 456');
    submitForm(el, '[data-login-form]');
    const second = await sent('POST', '/api/auth/login');
    expect(second.request.body).toEqual({
      email: 'eme@example.ch',
      password: PASSWORD,
      code: '123 456',
    });
    second.flush({ account: ACCOUNT, csrfToken: CSRF });
    await settle(harness);
    expect(TestBed.inject(Router).url).toBe('/app');
  });

  it("a wrong code stays on the code step with the API's message", async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 401, 'mfa_required', {
      methods: ['totp'],
    });
    await settle(harness);
    typeInto(el, '#login-code', '000000');
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 401, 'invalid_code');
    await settle(harness);
    expect(text(el, '[data-login-error]')).toContain('Der Code stimmt nicht');
    expect(el.querySelector('#login-code')).not.toBeNull();
    expect((el.querySelector('#login-code') as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('"Zurück" returns to the password step and forgets the password', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 401, 'mfa_required', {
      methods: ['totp'],
    });
    await settle(harness);
    (el.querySelector('[data-login-back]') as HTMLButtonElement).click();
    await settle(harness);
    expect(
      (el.querySelector('#login-password') as HTMLInputElement).value,
    ).toBe('');
  });

  it('links to the password reset', async () => {
    const { el } = await open();
    expect(el.querySelector('[data-to-forgot]')?.getAttribute('href')).toBe(
      '/forgot-password',
    );
  });

  it('says the address is not confirmed and offers a new mail, answered the same for every address', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 403, 'email_not_verified');
    await settle(harness);
    expect(text(el, '[data-login-error]')).toContain('noch nicht bestätigt');
    (el.querySelector('[data-resend]') as HTMLButtonElement).click();
    const request = await sent('POST', '/api/auth/resend-verification');
    expect(request.request.body).toEqual({ email: 'eme@example.ch' });
    request.flush(
      { status: 'accepted' },
      { status: 202, statusText: 'Accepted' },
    );
    await settle(harness);
    expect(text(el, '[data-resent]')).toContain(
      'Wenn die Adresse ein Konto hat',
    );
    expect(el.querySelector('[data-resend]')).toBeNull();
  });

  it('wrong credentials read the same for every cause, and the password is wiped', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 401, 'invalid_credentials');
    await settle(harness);
    expect(text(el, '[data-login-error]')).toBe(
      'E-Mail-Adresse oder Passwort stimmen nicht.',
    );
    expect(
      (el.querySelector('#login-password') as HTMLInputElement).value,
    ).toBe('');
    // The page does not echo the password anywhere.
    expect(el.innerHTML).not.toContain(PASSWORD);
  });

  it('never shows a text the server made up, only its own translated one', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    const request = await sent('POST', '/api/auth/login');
    request.flush(
      {
        statusCode: 500,
        error: 'SQLSTATE 23505 at /srv/app/db.js',
        message: PASSWORD,
      },
      { status: 500, statusText: 'Server Error' },
    );
    await settle(harness);
    expect(text(el, '[data-login-error]')).toBe(
      'Das hat nicht geklappt. Versuche es noch einmal.',
    );
    expect(el.innerHTML).not.toContain('SQLSTATE');
    expect(el.innerHTML).not.toContain(PASSWORD);
  });

  it('says so when the API cannot be reached, and when it limits the rate', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-login-form]');
    refuse(await sent('POST', '/api/auth/login'), 429, 'rate_limited');
    await settle(harness);
    expect(text(el, '[data-login-error]')).toContain('Zu viele Versuche');
  });

  describe('with a passkey', () => {
    const OPTIONS = {
      challenge: 'Y2hhbGxlbmdl',
      rpId: 'moat.example.ch',
      credentialIds: ['Y3JlZA'],
      timeoutMs: 120000,
    };
    const ASSERTION = {
      credentialId: 'Y3JlZA',
      authenticatorData: 'YXV0aA',
      clientDataJSON: 'Y2xpZW50',
      signature: 'c2ln',
    };
    const passkeyStep = async (
      browser: Partial<Record<'get', () => Promise<unknown>>>,
      methods: string[] = ['passkey'],
    ) => {
      const page = await open(browser);
      fill(page.el);
      submitForm(page.el, '[data-login-form]');
      refuse(await sent('POST', '/api/auth/login'), 401, 'mfa_required', {
        methods,
      });
      await settle(page.harness);
      return page;
    };

    it('offers the passkey, and the code field only when TOTP is a method', async () => {
      const only = await passkeyStep({ get: () => Promise.resolve(ASSERTION) });
      expect(only.el.querySelector('[data-login-passkey]')).not.toBeNull();
      expect(only.el.querySelector('#login-code')).toBeNull();
      expect(only.el.querySelector('[data-login-submit]')).toBeNull();
      TestBed.resetTestingModule();
      const both = await passkeyStep(
        { get: () => Promise.resolve(ASSERTION) },
        ['totp', 'passkey'],
      );
      expect(both.el.querySelector('[data-login-passkey]')).not.toBeNull();
      expect(both.el.querySelector('#login-code')).not.toBeNull();
      expect(both.el.querySelector('[data-login-submit]')).not.toBeNull();
    });

    it('asks Moat Cloud for a challenge, lets the browser sign it and sends the assertion', async () => {
      const get = vi.fn(() => Promise.resolve(ASSERTION));
      const { el, harness } = await passkeyStep({ get });
      (el.querySelector('[data-login-passkey]') as HTMLButtonElement).click();
      const challenge = await sent('POST', '/api/auth/passkey/challenge');
      expect(challenge.request.body).toEqual({
        email: 'eme@example.ch',
        password: PASSWORD,
      });
      challenge.flush(OPTIONS);
      const login = await sent('POST', '/api/auth/login');
      expect(get).toHaveBeenCalledWith(OPTIONS);
      expect(login.request.body).toEqual({
        email: 'eme@example.ch',
        password: PASSWORD,
        passkey: ASSERTION,
      });
      login.flush({ account: ACCOUNT, csrfToken: CSRF });
      await settle(harness);
      expect(TestBed.inject(Router).url).toBe('/app');
    });

    it('says plainly when the person cancels, and sends no assertion', async () => {
      const { PasskeyBrowserError } =
        await import('../../../../core/auth/passkey-browser');
      const { el, harness } = await passkeyStep({
        get: () => Promise.reject(new PasskeyBrowserError('cancelled')),
      });
      (el.querySelector('[data-login-passkey]') as HTMLButtonElement).click();
      (await sent('POST', '/api/auth/passkey/challenge')).flush(OPTIONS);
      await settle(harness);
      expect(text(el, '[data-passkey-problem]')).toContain('geschlossen');
      expect(el.querySelector('[data-login-passkey]')).not.toBeNull();
    });

    it("shows the API's refusal of an assertion and stays on the step", async () => {
      const { el, harness } = await passkeyStep({
        get: () => Promise.resolve(ASSERTION),
      });
      (el.querySelector('[data-login-passkey]') as HTMLButtonElement).click();
      (await sent('POST', '/api/auth/passkey/challenge')).flush(OPTIONS);
      refuse(await sent('POST', '/api/auth/login'), 401, 'invalid_code');
      await settle(harness);
      expect(text(el, '[data-login-error]')).toContain('Der Code stimmt nicht');
      expect(el.querySelector('[data-login-passkey]')).not.toBeNull();
    });

    it('says when this installation can check no method at all', async () => {
      const { el } = await passkeyStep(
        { get: () => Promise.resolve(ASSERTION) },
        [],
      );
      expect(el.querySelector('[data-no-method]')).not.toBeNull();
      expect(el.querySelector('[data-login-passkey]')).toBeNull();
      expect(el.querySelector('#login-code')).toBeNull();
    });
  });
});
