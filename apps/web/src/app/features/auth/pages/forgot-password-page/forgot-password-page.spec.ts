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
import { ForgotPasswordPage } from './forgot-password-page';

const ROUTES = [
  { path: 'forgot-password', component: ForgotPasswordPage },
  { path: 'login', children: [] },
];

describe('ForgotPasswordPage (Passwort vergessen)', () => {
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'de-CH'));
  afterEach(() => localStorage.clear());

  it('sends nothing for a malformed address', async () => {
    const { el, harness } = await openPage('/forgot-password', ROUTES, {});
    typeInto(el, '#forgot-email', 'not-an-address');
    submitForm(el, '[data-forgot-form]');
    await settle(harness);
    expect(el.querySelector('[data-forgot-accepted]')).toBeNull();
  });

  it('says only that a mail is on its way if there is an account (T-79)', async () => {
    const { el, harness } = await openPage('/forgot-password', ROUTES, {});
    typeInto(el, '#forgot-email', 'eme@example.ch');
    submitForm(el, '[data-forgot-form]');
    const request = await sent('POST', '/api/auth/forgot-password');
    expect(request.request.body).toEqual({ email: 'eme@example.ch' });
    request.flush(
      { status: 'accepted' },
      { status: 202, statusText: 'Accepted' },
    );
    await settle(harness);
    const done = text(el, '[data-forgot-accepted]');
    expect(done).toContain('Wenn es ein Konto mit dieser Adresse gibt');
    expect(done).toContain('sagt nicht, ob eine Adresse ein Konto hat');
    expect(done).not.toContain('eme@example.ch');
  });

  it('shows the API refusal when asked too often', async () => {
    const { el, harness } = await openPage('/forgot-password', ROUTES, {});
    typeInto(el, '#forgot-email', 'eme@example.ch');
    submitForm(el, '[data-forgot-form]');
    refuse(
      await sent('POST', '/api/auth/forgot-password'),
      429,
      'rate_limited',
    );
    await settle(harness);
    expect(text(el, '[data-forgot-error]')).toContain('Zu viele Versuche');
  });
});
