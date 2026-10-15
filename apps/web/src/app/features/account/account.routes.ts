import type { Routes } from '@angular/router';

/** Moat Cloud: the signed-in account (`/app/account`). */
const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/account-page/account-page').then((m) => m.AccountPage),
  },
];

export default routes;
