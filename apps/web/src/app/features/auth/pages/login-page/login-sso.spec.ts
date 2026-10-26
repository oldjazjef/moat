import { LOCALE_STORAGE_KEY } from '../../../../core/i18n/locales';
import { openPage } from '../../../../../testing/page-harness';
import { text } from '../../../../../testing/cloud-harness';
import { LoginPage } from './login-page';

const ROUTES = [{ path: 'login', component: LoginPage }];
const PROVIDERS = {
  providers: [{ id: 'fakeidp', name: 'Fake IdP' }],
};

describe('LoginPage single sign-on (SEC-51)', () => {
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'de-CH'));
  afterEach(() => localStorage.clear());

  it('offers a button per provider that leaves for the start address', async () => {
    const { el } = await openPage('/login', ROUTES, {
      '/api/auth/oidc/providers': PROVIDERS,
    });
    const button = el.querySelector('[data-sso-provider]');
    expect(button?.getAttribute('data-provider')).toBe('fakeidp');
    expect(button?.getAttribute('href')).toContain('/auth/oidc/fakeidp/start');
    expect(button?.textContent).toContain('Fake IdP');
  });

  it('shows no single sign-on without a provider', async () => {
    const { el } = await openPage('/login', ROUTES, {});
    expect(el.querySelector('[data-sso]')).toBeNull();
  });

  it('names why the way back failed, only from the fixed list', async () => {
    const known = await openPage('/login?sso=email_taken', ROUTES, {});
    expect(text(known.el, '[data-sso-error]').length).toBeGreaterThan(0);
  });

  it('ignores an unknown result code', async () => {
    const { el } = await openPage('/login?sso=<script>', ROUTES, {});
    expect(el.querySelector('[data-sso-error]')).toBeNull();
  });
});
