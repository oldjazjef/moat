import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterOutlet,
} from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLanguages, lucideMoon, lucideSun } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmSidebarImports, HlmSidebarService } from '@moat/ui/sidebar';
import { filter, map } from 'rxjs';
import { LanguageService } from '../i18n/language.service';
import { SetupStateService } from '../setup/setup-state.service';
import { ThemeService } from '../theme/theme.service';
import {
  HELP_NAV_ITEM,
  isNavActive,
  NAV_ICONS,
  NAV_ITEMS,
  type NavItem,
  SETUP_NAV_ITEM,
} from './nav-config';

/**
 * The frame (as lazy-koins' shell): the spartan sidebar at the left — the app's name, the main
 * navigation from `nav-config.ts` (hidden until the setup wizard is finished), "Einrichtung"
 * (FR-73) and "Hilfe" (FR-70) in the footer — collapsible to icons on
 * desktop widths and an off-canvas sheet on narrow ones; at the right a slim top bar (sidebar
 * trigger, language, theme) and the page, the only part that scrolls.
 */
@Component({
  selector: 'mt-app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    NgIcon,
    TranslatePipe,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmSidebarImports,
  ],
  providers: [
    provideIcons({ ...NAV_ICONS, lucideLanguages, lucideMoon, lucideSun }),
  ],
  templateUrl: './app-shell.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShell {
  protected readonly items = NAV_ITEMS;
  protected readonly help = HELP_NAV_ITEM;
  protected readonly setupItem = SETUP_NAV_ITEM;
  /** FR-73: while the wizard is not finished, the main navigation is hidden (as lazy-koins). */
  protected readonly setupIncomplete = inject(SetupStateService).incomplete;
  protected readonly theme = inject(ThemeService);
  protected readonly language = inject(LanguageService);
  // A template literal: i18n-keys.spec.ts reads quoted dotted literals as translation keys.
  protected readonly logo = `favicon.svg`;

  private readonly sidebar = inject(HlmSidebarService);
  protected readonly sidebarOpen = computed(() =>
    this.sidebar.isMobile() ? this.sidebar.openMobile() : this.sidebar.open(),
  );

  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  constructor() {
    // The mobile sheet closes once a link took the user somewhere.
    effect(() => {
      this.url();
      this.sidebar.setOpenMobile(false);
    });
  }

  protected isActive(item: NavItem): boolean {
    return isNavActive(this.url(), item);
  }

  protected toggleLanguage(): void {
    this.language.use(this.language.locale() === 'de-CH' ? 'en' : 'de-CH');
  }
}
