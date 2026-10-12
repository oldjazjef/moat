import type { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/overview-page/overview-page').then((m) => m.OverviewPage),
  },
];

export default routes;
