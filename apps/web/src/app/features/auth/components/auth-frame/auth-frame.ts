import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLanguages } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { LanguageService } from '../../../../core/i18n/language.service';

/**
 * The frame of the pages before sign-in («Anmelden», «Registrieren»): the brand, the language
 * switch and the page in a centred column. Moat Cloud only; the page is projected.
 */
@Component({
  selector: 'mt-auth-frame',
  imports: [NgIcon, TranslatePipe, HlmBadge, ...HlmButtonImports],
  providers: [provideIcons({ lucideLanguages })],
  template: `
    <div class="bg-background flex min-h-dvh flex-col">
      <header class="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
        <span class="flex items-center gap-2">
          <img [src]="logo" alt="" class="size-6 shrink-0" />
          <span class="mt-brand">{{ 'app.name' | translate }}</span>
          <span
            hlmBadge
            variant="outline"
            class="text-muted-foreground font-normal"
          >
            {{ 'app.editionCloud' | translate }}
          </span>
        </span>
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          type="button"
          data-language-toggle
          [attr.title]="'nav.toggleLanguage' | translate"
          (click)="toggleLanguage()"
        >
          <ng-icon name="lucideLanguages" size="16" aria-hidden="true" />
          {{ 'nav.otherLanguage' | translate }}
        </button>
      </header>
      <main class="flex flex-1 items-start justify-center px-4 py-8 md:py-16">
        <div class="w-full max-w-md"><ng-content /></div>
      </main>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthFrame {
  private readonly language = inject(LanguageService);
  // A template literal: i18n-keys.spec.ts reads quoted dotted literals as translation keys.
  protected readonly logo = `favicon.svg`;

  protected toggleLanguage(): void {
    this.language.use(this.language.locale() === 'de-CH' ? 'en' : 'de-CH');
  }
}
