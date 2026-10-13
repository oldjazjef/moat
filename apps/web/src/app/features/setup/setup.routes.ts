import type { Routes } from '@angular/router';

/** FR-73: the setup wizard, `/app/setup?step=<id>`. */
const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/setup-page/setup-page').then((m) => m.SetupPage),
  },
];

export default routes;
