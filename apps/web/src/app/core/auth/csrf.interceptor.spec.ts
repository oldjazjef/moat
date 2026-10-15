import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AccountSession } from './account-session.service';
import {
  CSRF_HEADER,
  csrfInterceptor,
  sessionEndedInterceptor,
} from './csrf.interceptor';

const ACCOUNT = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  email: 'eme@example.ch',
  totpEnabled: false,
  createdAt: '2026-10-15T08:00:00.000Z',
};

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(
        withInterceptors([csrfInterceptor, sessionEndedInterceptor]),
      ),
      provideHttpClientTesting(),
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    controller: TestBed.inject(HttpTestingController),
    session: TestBed.inject(AccountSession),
  };
}

/** Signs in with the CSRF token the API would hand out. */
async function signIn(
  session: AccountSession,
  controller: HttpTestingController,
  csrfToken = 'csrf-token-1',
) {
  const done = session.login(ACCOUNT.email, 'a long enough password');
  controller
    .expectOne('/api/auth/login')
    .flush({ account: ACCOUNT, csrfToken });
  await done;
}

describe('csrfInterceptor (T-78)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('sends the token of the sign-in with every unsafe request to the API', async () => {
    const { http, controller, session } = setup();
    await signIn(session, controller);
    for (const method of ['post', 'patch', 'put'] as const) {
      http[method]('/api/orgs', {}).subscribe();
      const request = controller.expectOne('/api/orgs');
      expect(request.request.headers.get(CSRF_HEADER)).toBe('csrf-token-1');
      request.flush({});
    }
    http.delete('/api/orgs').subscribe();
    const deleted = controller.expectOne('/api/orgs');
    expect(deleted.request.headers.get(CSRF_HEADER)).toBe('csrf-token-1');
    deleted.flush({});
  });

  it('sends nothing with safe requests', async () => {
    const { http, controller, session } = setup();
    await signIn(session, controller);
    http.get('/api/orgs').subscribe();
    const request = controller.expectOne('/api/orgs');
    expect(request.request.headers.has(CSRF_HEADER)).toBe(false);
    request.flush([]);
  });

  it('never sends the token to another address', async () => {
    const { http, controller, session } = setup();
    await signIn(session, controller);
    http.post('https://evil.example/api/x', {}).subscribe();
    http.post('/elsewhere', {}).subscribe();
    for (const url of ['https://evil.example/api/x', '/elsewhere']) {
      const request = controller.expectOne(url);
      expect(request.request.headers.has(CSRF_HEADER)).toBe(false);
      request.flush({});
    }
  });

  it('sends nothing before sign-in, and nothing after the account is forgotten', async () => {
    const { http, controller, session } = setup();
    http.post('/api/auth/login', {}).subscribe({ error: () => undefined });
    const first = controller.expectOne('/api/auth/login');
    expect(first.request.headers.has(CSRF_HEADER)).toBe(false);
    first.flush({}, { status: 401, statusText: 'Unauthorized' });
    await signIn(session, controller);
    session.expire();
    http.post('/api/orgs', {}).subscribe();
    const request = controller.expectOne('/api/orgs');
    expect(request.request.headers.has(CSRF_HEADER)).toBe(false);
    request.flush({});
  });

  it('uses the newer token after a password change', async () => {
    const { http, controller, session } = setup();
    await signIn(session, controller);
    session.adoptCsrf('csrf-token-2');
    http.post('/api/orgs', {}).subscribe();
    const request = controller.expectOne('/api/orgs');
    expect(request.request.headers.get(CSRF_HEADER)).toBe('csrf-token-2');
    request.flush({});
  });
});

describe('sessionEndedInterceptor', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('forgets the account and opens the sign-in when the session is gone', async () => {
    const { http, controller, session } = setup();
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    await signIn(session, controller);
    http.get('/api/orgs').subscribe({ error: () => undefined });
    controller
      .expectOne('/api/orgs')
      .flush(
        { statusCode: 401, error: 'unauthenticated' },
        { status: 401, statusText: 'Unauthorized' },
      );
    expect(session.signedIn()).toBe(false);
    expect(session.csrfToken()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it("leaves a wrong password alone (that is the call's own answer)", async () => {
    const { http, controller, session } = setup();
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    await signIn(session, controller);
    http
      .post('/api/auth/totp/disable', {})
      .subscribe({ error: () => undefined });
    controller
      .expectOne('/api/auth/totp/disable')
      .flush(
        { statusCode: 401, error: 'invalid_credentials' },
        { status: 401, statusText: 'Unauthorized' },
      );
    expect(session.signedIn()).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });
});
