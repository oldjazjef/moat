import type { Routes } from '@angular/router';

/** FR-71: the step-by-step guide (`/app/help#<section>`). */
const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/help-page/help-page').then((m) => m.HelpPage),
  },
];

export default routes;
