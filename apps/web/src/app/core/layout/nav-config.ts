import {
  lucideCircleHelp,
  lucideLayoutDashboard,
  lucideRoute,
  lucideServer,
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
  {
    path: '/app/overview',
    labelKey: 'nav.overview',
    icon: 'lucideLayoutDashboard',
  },
  { path: '/app/gates', labelKey: 'nav.gates', icon: 'lucideServer' },
  { path: '/app/routes', labelKey: 'nav.routes', icon: 'lucideRoute' },
];

/** "Hilfe" (FR-70): the last entry of the sidebar, in its footer. */
export const HELP_NAV_ITEM: NavItem = {
  path: '/app/help',
  labelKey: 'nav.help',
  icon: 'lucideCircleHelp',
};

export const NAV_ICONS = {
  lucideCircleHelp,
  lucideLayoutDashboard,
  lucideRoute,
  lucideServer,
};

/** Whether a navigation entry is the current one: the URL lies under its path. */
export function isNavActive(url: string, item: NavItem): boolean {
  const current = url.split(/[?#]/)[0] ?? '';
  return current === item.path || current.startsWith(`${item.path}/`);
}
