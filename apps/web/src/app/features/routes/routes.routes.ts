import type { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/routes-page/routes-page').then((m) => m.RoutesPage),
  },
];

export default routes;
