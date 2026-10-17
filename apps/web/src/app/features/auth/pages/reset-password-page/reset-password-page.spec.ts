import { LOCALE_STORAGE_KEY } from '../../../../core/i18n/locales';
import { openPage } from '../../../../../testing/page-harness';
import {
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import { ResetPasswordPage } from './reset-password-page';

const TOKEN = 'R'.repeat(43);
const PASSWORD = 'a long enough new passphrase';
const ROUTES = [
  { path: 'reset-password', component: ResetPasswordPage },
  { path: 'forgot-password', children: [] },
  { path: 'login', children: [] },
];
const open = () => openPage(`/reset-password#token=${TOKEN}`, ROUTES, {});

describe('ResetPasswordPage (Neues Passwort)', () => {
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'de-CH'));
  afterEach(() => localStorage.clear());

  it('offers a new link instead of a form when the link has no token', async () => {
    const { el } = await openPage('/reset-password', ROUTES, {});
    expect(el.querySelector('[data-reset-form]')).toBeNull();
    expect(el.querySelector('[data-to-forgot]')?.getAttribute('href')).toBe(
      '/forgot-password',
    );
  });

  it('sends nothing for a short or a mismatched password', async () => {
    const { el, harness } = await open();
    typeInto(el, '#reset-password', 'short');
    typeInto(el, '#reset-repeat', 'short');
    submitForm(el, '[data-reset-form]');
    await settle(harness);
    typeInto(el, '#reset-password', PASSWORD);
    typeInto(el, '#reset-repeat', `${PASSWORD}x`);
    submitForm(el, '[data-reset-form]');
    await settle(harness);
    expect(el.querySelector('[data-mismatch]')).not.toBeNull();
    expect(el.querySelector('[data-reset-done]')).toBeNull();
  });

  it('sends the token and the password once, wipes the form and says to sign in', async () => {
    const { el, harness } = await open();
    typeInto(el, '#reset-password', PASSWORD);
    typeInto(el, '#reset-repeat', PASSWORD);
    submitForm(el, '[data-reset-form]');
    const request = await sent('POST', '/api/auth/reset-password');
    expect(request.request.body).toEqual({
      token: TOKEN,
      newPassword: PASSWORD,
    });
    request.flush({ status: 'ok' });
    await settle(harness);
    expect(text(el, '[data-reset-done]')).toContain(
      'Alle Sitzungen wurden beendet',
    );
    expect(el.innerHTML).not.toContain(PASSWORD);
    expect(el.querySelector('[data-to-login]')?.getAttribute('href')).toBe(
      '/login',
    );
  });

  it('shows the plain refusal of a used or expired link, with a way to ask again', async () => {
    const { el, harness } = await open();
    typeInto(el, '#reset-password', PASSWORD);
    typeInto(el, '#reset-repeat', PASSWORD);
    submitForm(el, '[data-reset-form]');
    refuse(
      await sent('POST', '/api/auth/reset-password'),
      422,
      'invalid_token',
    );
    await settle(harness);
    expect(text(el, '[data-reset-error]')).toContain('gilt nicht (mehr)');
    expect(el.querySelector('[data-to-forgot]')).not.toBeNull();
    expect(
      (el.querySelector('#reset-password') as HTMLInputElement).value,
    ).toBe('');
  });
});
