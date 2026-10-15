import type { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/projects-page/projects-page').then((m) => m.ProjectsPage),
  },
  {
    // The workspace of one project: header, tabs, and the tab below (as lazy-koins).
    path: ':id',
    loadComponent: () =>
      import('./pages/project-workspace/project-workspace').then(
        (m) => m.ProjectWorkspace,
      ),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadChildren: () => import('../overview/overview.routes'),
      },
      {
        path: 'gates',
        loadChildren: () => import('../gates/gates.routes'),
      },
      {
        path: 'routes',
        loadChildren: () => import('../routes/routes.routes'),
      },
      {
        path: 'console',
        loadChildren: () => import('../console/console.routes'),
      },
      {
        path: 'history',
        loadChildren: () => import('../history/history.routes'),
      },
    ],
  },
];

export default routes;
