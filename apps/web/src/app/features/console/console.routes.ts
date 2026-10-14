import type { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/console-page/console-page').then((m) => m.ConsolePage),
  },
];

export default routes;
