import type { Route } from '@angular/router';
import { setupGuard } from './core/setup/setup-state.service';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'app' },
  {
    // Everything lives under /app, inside the shell with the sidebar.
    path: 'app',
    loadComponent: () =>
      import('./core/layout/app-shell').then((m) => m.AppShell),
    // FR-73: until the wizard is finished, every page but the help opens it.
    canActivateChild: [setupGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'projects' },
      {
        // The start page, and each project's workspace below it.
        path: 'projects',
        loadChildren: () => import('./features/projects/projects.routes'),
      },
      {
        // FR-73: the setup wizard — on the first start, and again from the sidebar.
        path: 'setup',
        loadChildren: () => import('./features/setup/setup.routes'),
      },
      {
        // FR-70: the step-by-step guide.
        path: 'help',
        loadChildren: () => import('./features/help/help.routes'),
      },
    ],
  },
  { path: '**', redirectTo: 'app' },
];
