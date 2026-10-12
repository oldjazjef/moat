import type { Route } from '@angular/router';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'app' },
  {
    // Everything lives under /app, inside the shell with the sidebar.
    path: 'app',
    loadComponent: () =>
      import('./core/layout/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'projects' },
      {
        // The start page, and each project's workspace below it.
        path: 'projects',
        loadChildren: () => import('./features/projects/projects.routes'),
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
