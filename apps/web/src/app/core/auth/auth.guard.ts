import { inject } from '@angular/core';
import {
  type CanActivateChildFn,
  type CanActivateFn,
  type CanMatchFn,
  Router,
} from '@angular/router';
import { isCloud } from '../config/runtime-env';
import { AccountSession } from './account-session.service';

/**
 * Moat Cloud: every page of /app needs a signed-in account, else the sign-in opens. The session
 * is the cookie; the API is asked once (`GET /auth/me`). Moat Desktop has no sign-in: the guard
 * lets everything through.
 */
export const authGuard: CanActivateChildFn = async () => {
  if (!isCloud()) return true;
  // Injected before the await: an injection context ends at the first one.
  const router = inject(Router);
  const account = await inject(AccountSession).load();
  return account !== null ? true : router.createUrlTree(['/login']);
};

/** Sign-in and registration: someone already signed in goes to the app instead. */
export const guestGuard: CanActivateFn = async () => {
  const router = inject(Router);
  if (!isCloud()) return router.createUrlTree(['/app']);
  const account = await inject(AccountSession).load();
  return account === null ? true : router.createUrlTree(['/app']);
};

/** The page exists in Moat Cloud only; in the desktop the route is not there. */
export const cloudOnly: CanMatchFn = () => isCloud();

/** The page exists in Moat Desktop only (it reads project folders). */
export const desktopOnly: CanMatchFn = () => !isCloud();
