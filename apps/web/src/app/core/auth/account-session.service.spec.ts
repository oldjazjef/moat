import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AccountSession } from './account-session.service';

const ACCOUNT = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  email: 'eme@example.ch',
  totpEnabled: false,
  createdAt: '2026-10-15T08:00:00.000Z',
};
const PASSWORD = 'planted-password-never-stored';

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    session: TestBed.inject(AccountSession),
    controller: TestBed.inject(HttpTestingController),
  };
}

/** Everything the page could have written to the browser's storage. */
const storageDump = () =>
  JSON.stringify([
    ...Object.entries(localStorage),
    ...Object.entries(sessionStorage),
  ]);

/** Whether a string appears anywhere in an object's own fields (functions and cycles skipped). */
function holds(
  root: unknown,
  needle: string,
  seen = new Set<unknown>(),
): boolean {
  if (typeof root === 'string') return root.includes(needle);
  if (typeof root !== 'object' || root === null || seen.has(root)) return false;
  seen.add(root);
  return Object.values(root).some((value) => holds(value, needle, seen));
}

describe('AccountSession', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("knows the account of the cookie's session from GET /auth/me and keeps its CSRF token", async () => {
    const { session, controller } = setup();
    const loaded = session.load();
    controller
      .expectOne('/api/auth/me')
      .flush({ account: ACCOUNT, csrfToken: 'csrf-1' });
    expect(await loaded).toEqual(ACCOUNT);
    expect(session.csrfToken()).toBe('csrf-1');
    // Cached: no second request.
    expect(await session.load()).toEqual(ACCOUNT);
  });

  it('is signed out when the API says 401, and asks only once', async () => {
    const { session, controller } = setup();
    const loaded = session.load();
    controller
      .expectOne('/api/auth/me')
      .flush(
        { statusCode: 401, error: 'unauthenticated' },
        { status: 401, statusText: 'Unauthorized' },
      );
    expect(await loaded).toBeNull();
    expect(session.signedIn()).toBe(false);
    expect(await session.load()).toBeNull();
  });

  it("puts no token, no password and no address into the browser's storage (no tokens in localStorage)", async () => {
    const { session, controller } = setup();
    const done = session.login(ACCOUNT.email, PASSWORD, '123456');
    const request = controller.expectOne('/api/auth/login');
    expect(request.request.body).toEqual({
      email: ACCOUNT.email,
      password: PASSWORD,
      code: '123456',
    });
    request.flush({ account: ACCOUNT, csrfToken: 'csrf-secret-token' });
    await done;
    const dump = storageDump();
    for (const secret of [PASSWORD, 'csrf-secret-token', ACCOUNT.email]) {
      expect(dump).not.toContain(secret);
    }
    expect(document.cookie).not.toContain('csrf');
  });

  it('holds no password after the sign-in (not in any field of the service)', async () => {
    const { session, controller } = setup();
    const done = session.login(ACCOUNT.email, PASSWORD);
    controller
      .expectOne('/api/auth/login')
      .flush({ account: ACCOUNT, csrfToken: 'csrf-1' });
    await done;
    expect(holds(session, PASSWORD)).toBe(false);
  });

  it('asks for the second factor without sending an empty code', async () => {
    const { session, controller } = setup();
    const done = session.login(ACCOUNT.email, PASSWORD, '');
    const request = controller.expectOne('/api/auth/login');
    expect(request.request.body).toEqual({
      email: ACCOUNT.email,
      password: PASSWORD,
    });
    request.flush(
      { statusCode: 401, error: 'mfa_required' },
      { status: 401, statusText: 'Unauthorized' },
    );
    await expect(done).rejects.toMatchObject({ status: 401 });
    expect(session.signedIn()).toBe(false);
  });

  it('forgets the account on sign-out even when the server cannot be reached', async () => {
    const { session, controller } = setup();
    const done = session.login(ACCOUNT.email, PASSWORD);
    controller
      .expectOne('/api/auth/login')
      .flush({ account: ACCOUNT, csrfToken: 'csrf-1' });
    await done;
    const out = session.logout();
    controller.expectOne('/api/auth/logout').error(new ProgressEvent('error'));
    await expect(out).rejects.toBeTruthy();
    expect(session.signedIn()).toBe(false);
    expect(session.csrfToken()).toBeNull();
  });
});
