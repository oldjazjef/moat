import type { Route } from '@angular/router';
import {
  authGuard,
  cloudOnly,
  desktopOnly,
  guestGuard,
} from './core/auth/auth.guard';
import { isCloud } from './core/config/runtime-env';
import { setupGuard } from './core/setup/setup-state.service';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'app' },
  {
    // Moat Cloud: sign in and register, outside the shell (a signed-in account goes to /app).
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/auth/pages/login-page/login-page').then(
        (m) => m.LoginPage,
      ),
  },
  {
    path: 'register',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/auth/pages/register-page/register-page').then(
        (m) => m.RegisterPage,
      ),
  },
  {
    // The pages the mailed links open. No guest guard: a signed-in person may open them too (an
    // invitation link for a second account), and none of them signs anybody in.
    path: 'verify-email',
    canMatch: [cloudOnly],
    loadComponent: () =>
      import('./features/auth/pages/verify-email-page/verify-email-page').then(
        (m) => m.VerifyEmailPage,
      ),
  },
  {
    path: 'forgot-password',
    canMatch: [cloudOnly],
    loadComponent: () =>
      import('./features/auth/pages/forgot-password-page/forgot-password-page').then(
        (m) => m.ForgotPasswordPage,
      ),
  },
  {
    path: 'reset-password',
    canMatch: [cloudOnly],
    loadComponent: () =>
      import('./features/auth/pages/reset-password-page/reset-password-page').then(
        (m) => m.ResetPasswordPage,
      ),
  },
  {
    // Everything lives under /app, inside the shell with the sidebar.
    path: 'app',
    loadComponent: () =>
      import('./core/layout/app-shell').then((m) => m.AppShell),
    // Moat Cloud: without a session the sign-in opens. FR-73 (Desktop): until the wizard is
    // finished, every page but the help opens it.
    canActivateChild: [authGuard, setupGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        redirectTo: () => (isCloud() ? 'organisations' : 'projects'),
      },
      {
        // Moat Cloud only: the account (password, second factor).
        path: 'account',
        canMatch: [cloudOnly],
        loadChildren: () => import('./features/account/account.routes'),
      },
      {
        // Moat Cloud only: organisations, their members and projects.
        path: 'organisations',
        canMatch: [cloudOnly],
        loadChildren: () =>
          import('./features/organisations/organisations.routes'),
      },
      {
        // The start page, and each project's workspace below it.
        path: 'projects',
        canMatch: [desktopOnly],
        loadChildren: () => import('./features/projects/projects.routes'),
      },
      {
        // FR-73: the setup wizard — on the first start, and again from the sidebar.
        path: 'setup',
        canMatch: [desktopOnly],
        loadChildren: () => import('./features/setup/setup.routes'),
      },
      {
        // FR-70: the step-by-step guide.
        path: 'help',
        loadChildren: () => import('./features/help/help.routes'),
      },
    ],
  },
  { path: '**', redirectTo: 'app' },
];
