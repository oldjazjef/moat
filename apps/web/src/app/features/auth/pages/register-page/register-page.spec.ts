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
import { RegisterPage } from './register-page';

const PASSWORD = 'planted-long-password-1';
const ROUTES = [
  { path: 'register', component: RegisterPage },
  { path: 'login', children: [] },
];

const open = () => openPage('/register', ROUTES, {});

function fill(el: HTMLElement, repeat = PASSWORD) {
  typeInto(el, '#register-email', 'neu@example.ch');
  typeInto(el, '#register-password', PASSWORD);
  typeInto(el, '#register-repeat', repeat);
}

describe('RegisterPage (Registrieren)', () => {
  // The frame reads the stored language (the German texts of the harness).
  beforeEach(() => localStorage.setItem(LOCALE_STORAGE_KEY, 'de-CH'));
  it('shows the form with the length rule', async () => {
    const { el } = await open();
    expect(text(el, 'h1')).toBe('Konto erstellen');
    expect(text(el, '#register-password-hint')).toContain('12 Zeichen');
  });

  it('sends nothing for a short password or a malformed address', async () => {
    const { el, harness } = await open();
    typeInto(el, '#register-email', 'neu@example.ch');
    typeInto(el, '#register-password', 'short');
    typeInto(el, '#register-repeat', 'short');
    submitForm(el, '[data-register-form]');
    await settle(harness);
    expect(el.querySelector('[data-register-accepted]')).toBeNull();
    typeInto(el, '#register-email', 'neu');
    typeInto(el, '#register-password', PASSWORD);
    typeInto(el, '#register-repeat', PASSWORD);
    submitForm(el, '[data-register-form]');
    await settle(harness);
    expect(el.querySelector('[data-register-accepted]')).toBeNull();
  });

  it('does not send two different passwords', async () => {
    const { el, harness } = await open();
    fill(el, `${PASSWORD}x`);
    submitForm(el, '[data-register-form]');
    await settle(harness);
    expect(el.querySelector('[data-mismatch]')).not.toBeNull();
  });

  it('says only that the request was accepted, never that the account exists (T-79)', async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-register-form]');
    const request = await sent('POST', '/api/auth/register');
    expect(request.request.body).toEqual({
      email: 'neu@example.ch',
      password: PASSWORD,
    });
    request.flush(
      { status: 'accepted' },
      { status: 202, statusText: 'Accepted' },
    );
    await settle(harness);
    const done = text(el, '[data-register-accepted]');
    expect(done).toContain('Wenn die Adresse noch frei war');
    expect(done).toContain('sagt nicht, ob eine Adresse schon benutzt wird');
    expect(el.querySelector('[data-to-login]')?.getAttribute('href')).toBe(
      '/login',
    );
    expect(el.innerHTML).not.toContain(PASSWORD);
  });

  it("shows the API's refusal as its translated text and wipes the password", async () => {
    const { el, harness } = await open();
    fill(el);
    submitForm(el, '[data-register-form]');
    refuse(await sent('POST', '/api/auth/register'), 422, 'password_too_short');
    await settle(harness);
    expect(text(el, '[data-register-error]')).toBe(
      'Das Passwort muss mindestens 12 Zeichen lang sein.',
    );
    expect(
      (el.querySelector('#register-password') as HTMLInputElement).value,
    ).toBe('');
    expect(
      (el.querySelector('#register-repeat') as HTMLInputElement).value,
    ).toBe('');
  });
});
