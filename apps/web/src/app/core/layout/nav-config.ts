import {
  lucideBuilding2,
  lucideCircleHelp,
  lucideFolderKanban,
  lucideListChecks,
  lucideUserRound,
  lucideUsers,
} from '@ng-icons/lucide';

export interface NavItem {
  readonly path: string;
  readonly labelKey: string;
  readonly icon: string;
  /** Active only on exactly this path, not below it. */
  readonly exact?: boolean;
}

/**
 * The main navigation in the sidebar, in order — its single source (`app-shell.html` only renders
 * it). Icon names must be registered in `NAV_ICONS`.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // Everything lives in a project (Übersicht, Gates, Routen are the tabs of its workspace).
  {
    path: '/app/projects',
    labelKey: 'nav.projects',
    icon: 'lucideFolderKanban',
  },
];

/** "Hilfe" (FR-70): the last entry of the sidebar, in its footer. */
export const HELP_NAV_ITEM: NavItem = {
  path: '/app/help',
  labelKey: 'nav.help',
  icon: 'lucideCircleHelp',
};

/** «Einrichtung» (FR-73): the setup wizard, again at any time; in the footer above «Hilfe». */
export const SETUP_NAV_ITEM: NavItem = {
  path: '/app/setup',
  labelKey: 'nav.setup',
  icon: 'lucideListChecks',
};

/** Moat Cloud: the list of organisations (switching happens there). */
export const ORGANISATIONS_NAV_ITEM: NavItem = {
  path: '/app/organisations',
  labelKey: 'nav.organisations',
  icon: 'lucideBuilding2',
  exact: true,
};

/** Moat Cloud: the pages of the organisation in use (`/app/organisations/<id>/…`). */
export function organisationNavItems(orgId: string): readonly NavItem[] {
  const base = `/app/organisations/${encodeURIComponent(orgId)}`;
  return [
    {
      path: `${base}/projects`,
      labelKey: 'nav.orgProjects',
      icon: 'lucideFolderKanban',
    },
    { path: `${base}/members`, labelKey: 'nav.members', icon: 'lucideUsers' },
  ];
}

/** Moat Cloud: «Konto», in the footer above «Hilfe». */
export const ACCOUNT_NAV_ITEM: NavItem = {
  path: '/app/account',
  labelKey: 'nav.account',
  icon: 'lucideUserRound',
};

export const NAV_ICONS = {
  lucideBuilding2,
  lucideCircleHelp,
  lucideFolderKanban,
  lucideListChecks,
  lucideUserRound,
  lucideUsers,
};

/** Whether a navigation entry is the current one: the URL lies under its path. */
export function isNavActive(url: string, item: NavItem): boolean {
  const current = url.split(/[?#]/)[0] ?? '';
  if (item.exact === true) return current === item.path;
  return current === item.path || current.startsWith(`${item.path}/`);
}
