import { TestBed } from '@angular/core/testing';
import { AccountSession } from '../../../../core/auth/account-session.service';
import {
  ACCOUNT,
  CSRF,
  click,
  openCloudPage,
  refuse,
  sent,
  settle,
  submitForm,
  text,
  typeInto,
} from '../../../../../testing/cloud-harness';
import { AccountPage } from './account-page';

const PASSWORD = 'planted-current-password';
const NEXT = 'planted-next-password-1';
const ROUTES = [{ path: 'app/account', component: AccountPage }];

const open = () => openCloudPage('/app/account', ROUTES, {});

describe('AccountPage (Konto)', () => {
  it('shows the account and the honest note, without any trust-mode claim', async () => {
    const { el } = await open();
    expect(text(el, 'h1')).toBe('Konto');
    expect(text(el, 'mt-page-header')).toContain('eme@example.ch');
    const note = text(el, '[data-account-honesty]');
    expect(note).toContain('keine Gates, Secrets und Bundles');
    expect(note).toContain('keinen Vertrauensmodus');
    // It points to the guide's trust section and claims no mode and no level itself.
    expect(
      el
        .querySelector('[data-account-honesty] [data-help-link]')
        ?.getAttribute('href'),
    ).toBe('/app/help#trust');
    expect(el.querySelector('[data-trust-mode]')).toBeNull();
    expect(el.querySelector('[data-totp-state="off"]')).not.toBeNull();
  });

  describe('password', () => {
    it('changes it, uses the new CSRF token and wipes the fields', async () => {
      const { el, harness } = await open();
      typeInto(el, '#password-current', PASSWORD);
      typeInto(el, '#password-new', NEXT);
      typeInto(el, '#password-repeat', NEXT);
      submitForm(el, '[data-password] form');
      const request = await sent('POST', '/api/auth/password');
      expect(request.request.body).toEqual({
        currentPassword: PASSWORD,
        newPassword: NEXT,
      });
      request.flush({ csrfToken: 'csrf-after-change' });
      await settle(harness);
      expect(el.querySelector('[data-password-changed]')).not.toBeNull();
      expect(TestBed.inject(AccountSession).csrfToken()).toBe(
        'csrf-after-change',
      );
      for (const id of [
        '#password-current',
        '#password-new',
        '#password-repeat',
      ]) {
        expect((el.querySelector(id) as HTMLInputElement).value).toBe('');
      }
      expect(el.innerHTML).not.toContain(NEXT);
    });

    it('does not send a short password or two different ones', async () => {
      const { el, harness } = await open();
      typeInto(el, '#password-current', PASSWORD);
      typeInto(el, '#password-new', 'short');
      typeInto(el, '#password-repeat', 'short');
      submitForm(el, '[data-password] form');
      await settle(harness);
      typeInto(el, '#password-new', NEXT);
      typeInto(el, '#password-repeat', `${NEXT}x`);
      submitForm(el, '[data-password] form');
      await settle(harness);
      expect(el.querySelector('[data-mismatch]')).not.toBeNull();
      expect(el.querySelector('[data-password-changed]')).toBeNull();
    });

    it("shows the API's refusal and wipes what was typed", async () => {
      const { el, harness } = await open();
      typeInto(el, '#password-current', PASSWORD);
      typeInto(el, '#password-new', NEXT);
      typeInto(el, '#password-repeat', NEXT);
      submitForm(el, '[data-password] form');
      refuse(
        await sent('POST', '/api/auth/password'),
        401,
        'invalid_credentials',
      );
      await settle(harness);
      expect(text(el, '[data-password-error]')).toBe(
        'E-Mail-Adresse oder Passwort stimmen nicht.',
      );
      expect(
        (el.querySelector('#password-current') as HTMLInputElement).value,
      ).toBe('');
    });
  });

  describe('second factor', () => {
    const SECRET = 'JBSWY3DPEHPK3PXP';
    const URI = `otpauth://totp/Moat:eme%40example.ch?secret=${SECRET}&issuer=Moat`;
    const CODES = ['aaaa-bbbb', 'cccc-dddd', 'eeee-ffff'];

    async function enrol() {
      const page = await open();
      typeInto(page.el, '#enrol-password', PASSWORD);
      submitForm(page.el, '[data-totp] form');
      const request = await sent('POST', '/api/auth/totp/enrol');
      expect(request.request.body).toEqual({ password: PASSWORD });
      request.flush({ secret: SECRET, otpauthUri: URI });
      await settle(page.harness);
      return page;
    }

    it('shows the secret and the otpauth address as text, once', async () => {
      const { el } = await enrol();
      expect(text(el, '[data-secret]')).toBe(SECRET);
      expect(text(el, '[data-uri]')).toBe(URI);
      // No QR code dependency: text only.
      expect(el.querySelector('canvas, img[src^="data:"]')).toBeNull();
      expect(
        (el.querySelector('#enrol-password') as HTMLInputElement | null)
          ?.value ?? '',
      ).toBe('');
    });

    it('confirms with a code, shows the recovery codes once and drops them on «Erledigt»', async () => {
      const { el, harness } = await enrol();
      typeInto(el, '#totp-confirm', '123456');
      submitForm(el, '[data-totp] form');
      const request = await sent('POST', '/api/auth/totp/confirm');
      expect(request.request.body).toEqual({ code: '123456' });
      request.flush({ recoveryCodes: CODES });
      await settle(harness);
      expect(
        [...el.querySelectorAll('[data-recovery-code]')].map(
          (li) => li.textContent,
        ),
      ).toEqual(CODES);
      // The secret is gone from the page as soon as the factor is on.
      expect(el.innerHTML).not.toContain(SECRET);
      expect(TestBed.inject(AccountSession).account()?.totpEnabled).toBe(true);
      click(el, '[data-codes-saved]');
      await settle(harness);
      expect(el.querySelector('[data-recovery-codes]')).toBeNull();
      expect(el.innerHTML).not.toContain(CODES[0]);
      expect(el.querySelector('[data-totp-state="on"]')).not.toBeNull();
      expect(el.querySelector('[data-totp-disable]')).not.toBeNull();
    });

    it("shows a wrong code as the API's message and keeps the secret for another try", async () => {
      const { el, harness } = await enrol();
      typeInto(el, '#totp-confirm', '000000');
      submitForm(el, '[data-totp] form');
      refuse(await sent('POST', '/api/auth/totp/confirm'), 401, 'invalid_code');
      await settle(harness);
      expect(text(el, '[data-confirm-error]')).toContain(
        'Der Code stimmt nicht',
      );
      expect(text(el, '[data-secret]')).toBe(SECRET);
    });

    it('cancelling drops the secret from the page', async () => {
      const { el, harness } = await enrol();
      click(el, '[data-enrol-cancel]');
      await settle(harness);
      expect(el.innerHTML).not.toContain(SECRET);
      expect(el.querySelector('[data-totp-enrol]')).not.toBeNull();
    });

    it('a wrong password at the start shows the uniform message and shows no secret', async () => {
      const { el, harness } = await open();
      typeInto(el, '#enrol-password', 'wrong');
      submitForm(el, '[data-totp] form');
      refuse(
        await sent('POST', '/api/auth/totp/enrol'),
        401,
        'invalid_credentials',
      );
      await settle(harness);
      expect(el.querySelector('[data-enrol-error]')).not.toBeNull();
      expect(el.querySelector('[data-secret]')).toBeNull();
    });

    it('turns it off with password and code', async () => {
      const { el, harness } = await openCloudPage('/app/account', ROUTES, {
        '/api/auth/me': {
          account: { ...ACCOUNT, totpEnabled: true },
          csrfToken: CSRF,
        },
      });
      expect(el.querySelector('[data-totp-state="on"]')).not.toBeNull();
      typeInto(el, '#disable-password', PASSWORD);
      typeInto(el, '#disable-code', '654321');
      submitForm(el, '[data-totp] form');
      const request = await sent('POST', '/api/auth/totp/disable');
      expect(request.request.body).toEqual({
        password: PASSWORD,
        code: '654321',
      });
      request.flush(null, { status: 204, statusText: 'No Content' });
      await settle(harness);
      expect(el.querySelector('[data-totp-state="off"]')).not.toBeNull();
      expect(el.querySelector('[data-totp-enrol]')).not.toBeNull();
    });
  });
});
