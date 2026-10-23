import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { authGuard, cloudOnly, desktopOnly, guestGuard } from './auth.guard';

const ACCOUNT = {
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  email: 'eme@example.ch',
  totpEnabled: false,
  passkeyCount: 0,
  createdAt: '2026-10-15T08:00:00.000Z',
};

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return TestBed.inject(HttpTestingController);
}

const run = <T>(fn: () => T): T => TestBed.runInInjectionContext(fn);
const url = (tree: unknown) =>
  TestBed.inject(Router).serializeUrl(tree as UrlTree);
const auth = () =>
  run(
    () =>
      authGuard(
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
      ) as Promise<boolean | UrlTree>,
  );
const guest = () =>
  run(
    () =>
      guestGuard(
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
      ) as Promise<boolean | UrlTree>,
  );

describe('route guards', () => {
  afterEach(() => {
    delete window.__MT_ENV__;
    TestBed.inject(HttpTestingController).verify();
  });

  it('Moat Desktop: no sign-in, every page opens and no request is made', async () => {
    setup();
    expect(await auth()).toBe(true);
    expect(url(await guest())).toBe('/app');
    expect(run(() => cloudOnly({} as never, [], {} as never))).toBe(false);
    expect(run(() => desktopOnly({} as never, [], {} as never))).toBe(true);
  });

  it('Moat Cloud: without a session the sign-in opens', async () => {
    window.__MT_ENV__ = { authMode: 'cloud' };
    const controller = setup();
    const result = auth();
    controller
      .expectOne('/api/auth/me')
      .flush(
        { statusCode: 401, error: 'unauthenticated' },
        { status: 401, statusText: 'Unauthorized' },
      );
    expect(url(await result)).toBe('/login');
    expect(run(() => cloudOnly({} as never, [], {} as never))).toBe(true);
    expect(run(() => desktopOnly({} as never, [], {} as never))).toBe(false);
  });

  it('Moat Cloud: with a session the page opens, and the sign-in sends the account on to the app', async () => {
    window.__MT_ENV__ = { authMode: 'cloud' };
    const controller = setup();
    const result = auth();
    controller
      .expectOne('/api/auth/me')
      .flush({ account: ACCOUNT, csrfToken: 'c' });
    expect(await result).toBe(true);
    expect(url(await guest())).toBe('/app');
  });

  it('Moat Cloud: sign-in and registration open for a visitor without a session', async () => {
    window.__MT_ENV__ = { authMode: 'cloud' };
    const controller = setup();
    const result = guest();
    controller
      .expectOne('/api/auth/me')
      .flush(
        { error: 'unauthenticated' },
        { status: 401, statusText: 'Unauthorized' },
      );
    expect(await result).toBe(true);
  });
});
