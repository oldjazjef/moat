import type { Routes } from '@angular/router';

/** «Assistent» (Moat Desktop): the AI chat over the projects, and the proposals to decide. */
const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/assistant-page/assistant-page').then(
        (m) => m.AssistantPage,
      ),
  },
];

export default routes;
