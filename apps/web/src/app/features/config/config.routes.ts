import type { Routes } from '@angular/router';

/** A project's moat.yaml in the editor (`?gate=<name>` marks that gate's entry). */
const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/config-page/config-page').then((m) => m.ConfigPage),
  },
];

export default routes;
