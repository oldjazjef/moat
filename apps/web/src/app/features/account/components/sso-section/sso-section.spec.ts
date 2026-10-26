import { TestBed } from '@angular/core/testing';
import { AccountSession } from '../../../../core/auth/account-session.service';
import { PageNavigation } from '../../../../core/auth/page-navigation';
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

const ROUTES = [{ path: 'app/account', component: AccountPage }];
const PROVIDERS = { providers: [{ id: 'fakeidp', name: 'Fake IdP' }] };

const open = (account = ACCOUNT, url = '/app/account') =>
  openPage(
    url,
    ROUTES,
    {
      '/api/auth/me': { account, csrfToken: CSRF },
      '/api/auth/passkeys': { passkeys: [] },
      '/api/auth/oidc/providers': PROVIDERS,
    },
    () => void TestBed.inject(AccountSession).load(),
  );

describe('SsoSection (SEC-51)', () => {
  it('offers to link a provider that is not linked yet', async () => {
    const { el } = await open();
    expect(el.querySelector('[data-sso-none]')).not.toBeNull();
    expect(el.querySelector('[data-sso-link]')?.textContent).toContain(
      'Fake IdP',
    );
  });

  it('lists a linked provider and offers it no more', async () => {
    const { el } = await open({ ...ACCOUNT, identities: ['fakeidp'] });
    expect(text(el, '[data-sso-identity]')).toBe('Fake IdP');
    expect(el.querySelector('[data-sso-link]')).toBeNull();
  });

  it('asks for the password, then leaves for the address the API gave', async () => {
    const { el, harness } = await open();
    const go = vi
      .spyOn(TestBed.inject(PageNavigation), 'go')
      .mockImplementation(() => undefined);
    click(el, '[data-sso-link]');
    harness.detectChanges();
    typeInto(el, '#sso-password', 'planted-current-password');
    submitForm(el, '[data-sso-link-form]');
    const request = await sent('POST', '/api/auth/oidc/fakeidp/link');
    expect(request.request.body).toEqual({
      password: 'planted-current-password',
    });
    request.flush({ url: 'https://idp.example/authorize?x=1' });
    await settle(harness);
    expect(go).toHaveBeenCalledWith('https://idp.example/authorize?x=1');
  });

  it('shows a refusal and does not leave', async () => {
    const { el, harness } = await open();
    const go = vi
      .spyOn(TestBed.inject(PageNavigation), 'go')
      .mockImplementation(() => undefined);
    click(el, '[data-sso-link]');
    harness.detectChanges();
    typeInto(el, '#sso-password', 'wrong-password-value');
    submitForm(el, '[data-sso-link-form]');
    refuse(
      await sent('POST', '/api/auth/oidc/fakeidp/link'),
      401,
      'invalid_credentials',
    );
    await settle(harness);
    expect(el.querySelector('[data-sso-error]')).not.toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it('reports the result of the way back', async () => {
    const { el } = await open(ACCOUNT, '/app/account?sso=linked');
    expect(el.querySelector('[data-sso-result]')).not.toBeNull();
  });

  it('hides password sections for an account without a password', async () => {
    const { el } = await open({
      ...ACCOUNT,
      hasPassword: false,
      identities: ['fakeidp'],
    });
    expect(el.querySelector('[data-no-password]')).not.toBeNull();
    expect(el.querySelector('[data-sso-link]')).toBeNull();
  });
});
