import {
  lucideCircleHelp,
  lucideFolderKanban,
  lucideListChecks,
} from '@ng-icons/lucide';

export interface NavItem {
  readonly path: string;
  readonly labelKey: string;
  readonly icon: string;
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

export const NAV_ICONS = {
  lucideCircleHelp,
  lucideFolderKanban,
  lucideListChecks,
};

/** Whether a navigation entry is the current one: the URL lies under its path. */
export function isNavActive(url: string, item: NavItem): boolean {
  const current = url.split(/[?#]/)[0] ?? '';
  return current === item.path || current.startsWith(`${item.path}/`);
}
