import type { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/gates-page/gates-page').then((m) => m.GatesPage),
  },
];

export default routes;
