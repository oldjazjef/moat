import type {
  HttpErrorResponse,
  HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { runtimeEnv } from '../config/runtime-env';
import { AccountSession } from './account-session.service';

/** The header the Cloud API checks on every state-changing request (T-78). */
export const CSRF_HEADER = 'x-moat-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Only requests to this app's own API carry the token — never a foreign URL. */
function isApiRequest(url: string): boolean {
  return url.startsWith(`${runtimeEnv().apiBaseUrl}/api/`);
}

/**
 * Adds the CSRF token the API returned on sign-in and `GET /auth/me` to every unsafe request to
 * the API. Without a signed-in account (Moat Desktop never has one) it does nothing.
 */
export const csrfInterceptor: HttpInterceptorFn = (request, next) => {
  if (SAFE_METHODS.has(request.method) || !isApiRequest(request.url)) {
    return next(request);
  }
  const token = inject(AccountSession).csrfToken();
  return next(
    token === null
      ? request
      : request.clone({ setHeaders: { [CSRF_HEADER]: token } }),
  );
};

/**
 * A 401 `unauthenticated` from the API while an account is signed in means the session is over
 * (expired, revoked, signed out elsewhere): forget the account and go to the sign-in. The sign-in
 * itself answers `invalid_credentials`, so it never triggers this.
 */
export const sessionEndedInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(AccountSession);
  const router = inject(Router);
  return next(request).pipe(
    catchError((error: HttpErrorResponse) => {
      const body: unknown = error.error;
      if (
        error.status === 401 &&
        isApiRequest(request.url) &&
        typeof body === 'object' &&
        body !== null &&
        (body as { error?: unknown }).error === 'unauthenticated' &&
        session.signedIn()
      ) {
        session.expire();
        void router.navigate(['/login']);
      }
      return throwError(() => error);
    }),
  );
};
