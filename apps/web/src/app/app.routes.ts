import type { Route } from '@angular/router';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'app' },
  {
    // Everything lives under /app, inside the shell with the sidebar.
    path: 'app',
    loadComponent: () =>
      import('./core/layout/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadChildren: () => import('./features/overview/overview.routes'),
      },
      {
        path: 'gates',
        loadChildren: () => import('./features/gates/gates.routes'),
      },
      {
        path: 'routes',
        loadChildren: () => import('./features/routes/routes.routes'),
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
