import type { Routes } from '@angular/router';

/** «Einstellungen» (Moat Desktop): the device's passkey and each project's signing key. */
const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/settings-page/settings-page').then((m) => m.SettingsPage),
  },
];

export default routes;
