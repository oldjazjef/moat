import type { ValueProvider } from '@angular/core';
import { provideHlmSidebarConfig } from '@moat/ui/sidebar';

/** The cookie that remembers expanded/collapsed on desktop widths (as lazy-koins). */
export const SIDEBAR_COOKIE = 'mt_sidebar';

/**
 * The shell's sidebar (`hlm-sidebar`, generated): expanded/collapsed is remembered for a year;
 * below `md` (768 px) it is an off-canvas sheet that closes once an entry was chosen.
 */
export function provideAppSidebar(): ValueProvider {
  return provideHlmSidebarConfig({
    sidebarCookieName: SIDEBAR_COOKIE,
    sidebarCookieMaxAge: 60 * 60 * 24 * 365,
    closeMobileSidebarOnMenuButtonClick: true,
  });
}
