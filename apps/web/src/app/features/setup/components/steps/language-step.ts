import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../../../core/i18n/language.service';
import type { SupportedLocale } from '../../../../core/i18n/locales';
import { provideSetupStep, SetupStepComponent } from '../setup-step';

/** Each language named in itself, so it can be found whatever is on screen. */
const CHOICES: readonly { locale: SupportedLocale; labelKey: string }[] = [
  { locale: 'de-CH', labelKey: 'setup.language.german' },
  { locale: 'en', labelKey: 'setup.language.english' },
];

/** FR-73, step «Sprache»: switches at once, like the button in the top bar. */
@Component({
  selector: 'mt-setup-language-step',
  imports: [TranslatePipe],
  providers: [provideSetupStep(() => LanguageStep)],
  template: `
    <fieldset class="flex flex-col gap-2" data-language-choices>
      <legend class="sr-only">{{ 'setup.language.legend' | translate }}</legend>
      @for (choice of choices; track choice.locale) {
        <label class="mt-choice" [attr.data-locale]="choice.locale">
          <input
            type="radio"
            name="language"
            [value]="choice.locale"
            [checked]="language.locale() === choice.locale"
            (change)="language.use(choice.locale)"
          />
          <span class="font-medium">{{ choice.labelKey | translate }}</span>
        </label>
      }
    </fieldset>
    <p class="text-muted-foreground mt-3 text-sm">
      {{ 'setup.language.later' | translate }}
    </p>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LanguageStep extends SetupStepComponent {
  protected readonly language = inject(LanguageService);
  protected readonly choices = CHOICES;

  async submit(): Promise<boolean> {
    return true;
  }
}
