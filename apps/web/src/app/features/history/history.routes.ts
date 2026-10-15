import type { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/history-page/history-page').then((m) => m.HistoryPage),
  },
];

export default routes;
