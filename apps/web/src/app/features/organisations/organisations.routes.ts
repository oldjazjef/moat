import type { Routes } from '@angular/router';

/** Moat Cloud: the organisations of the account and, below each, its projects and members. */
const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/organisations-page/organisations-page').then(
        (m) => m.OrganisationsPage,
      ),
  },
  { path: ':orgId', pathMatch: 'full', redirectTo: ':orgId/projects' },
  {
    path: ':orgId/projects',
    loadComponent: () =>
      import('./pages/org-projects-page/org-projects-page').then(
        (m) => m.OrgProjectsPage,
      ),
  },
  {
    path: ':orgId/projects/:projectId',
    pathMatch: 'full',
    loadComponent: () =>
      import('./pages/project-gates-page/project-gates-page').then(
        (m) => m.ProjectGatesPage,
      ),
  },
  {
    path: ':orgId/projects/:projectId/config',
    loadComponent: () =>
      import('./pages/project-config-page/project-config-page').then(
        (m) => m.ProjectConfigPage,
      ),
  },
  {
    path: ':orgId/audit',
    loadComponent: () =>
      import('./pages/audit-page/audit-page').then((m) => m.AuditPage),
  },
  {
    path: ':orgId/members',
    loadComponent: () =>
      import('./pages/members-page/members-page').then((m) => m.MembersPage),
  },
];

export default routes;
