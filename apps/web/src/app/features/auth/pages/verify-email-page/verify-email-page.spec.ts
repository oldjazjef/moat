import { LOCALE_STORAGE_KEY } from '../../../../core/i18n/locales';
import { openPage } from '../../../../../testing/page-harness';
import {
  refuse,
  sent,
  settle,
  text,
} from '../../../../../testing/cloud-harness';
import { VerifyEmailPage } from './verify-email-page';

const TOKEN = 'T'.repeat(43);
const ROUTES = [
  { path: 'verify-email', component: VerifyEmailPage },
  { path: 'login', children: [] },
];

describe('VerifyEmailPage (E-Mail-Adresse bestätigen)', () => {
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'de-CH'));
  afterEach(() => localStorage.clear());

  it('uses the token only when the person presses the button, so a mail scanner cannot', async () => {
    const { el, harness } = await openPage(
      `/verify-email#token=${TOKEN}`,
      ROUTES,
      {},
    );
    expect(text(el, 'h1')).toBe('E-Mail-Adresse bestätigen');
    // Nothing was sent by opening the page (the harness fails on an unexpected request).
    await settle(harness);
    (el.querySelector('[data-verify-submit]') as HTMLButtonElement).click();
    const request = await sent('POST', '/api/auth/verify-email');
    expect(request.request.body).toEqual({ token: TOKEN });
    request.flush({ status: 'ok' });
    await settle(harness);
    expect(el.textContent).toContain('Die Adresse ist bestätigt');
    expect(el.querySelector('[data-verify-submit]')).toBeNull();
    expect(el.querySelector('[data-to-login]')?.getAttribute('href')).toBe(
      '/login',
    );
  });

  it('shows one plain text for a link that no longer works', async () => {
    const { el, harness } = await openPage(
      `/verify-email#token=${TOKEN}`,
      ROUTES,
      {},
    );
    (el.querySelector('[data-verify-submit]') as HTMLButtonElement).click();
    refuse(await sent('POST', '/api/auth/verify-email'), 422, 'invalid_token');
    await settle(harness);
    expect(text(el, '[data-verify-error]')).toContain('gilt nicht (mehr)');
  });

  it('has no button, and sends nothing, for a link without a proper token', async () => {
    const { el } = await openPage('/verify-email#token=short', ROUTES, {});
    expect(el.querySelector('[data-verify-submit]')).toBeNull();
    expect(el.textContent).toContain('Dieser Link ist unvollständig');
  });
});
