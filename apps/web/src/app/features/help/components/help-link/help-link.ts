import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleHelp } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import type { HelpSectionId } from '../../help-content';

/**
 * Contextual help (FR-72): a "?" in a page header that opens the guide at the matching step
 * (`/app/help#<section>`). With `labelKey` it is a labelled outline button (the setup wizard).
 */
@Component({
  selector: 'mt-help-link',
  imports: [RouterLink, NgIcon, TranslatePipe, ...HlmButtonImports],
  providers: [provideIcons({ lucideCircleHelp })],
  template: `
    @if (labelKey(); as label) {
      <a
        hlmBtn
        variant="outline"
        routerLink="/app/help"
        [fragment]="section()"
        data-help-link
      >
        <ng-icon name="lucideCircleHelp" size="16" aria-hidden="true" />
        {{ label | translate }}
      </a>
    } @else {
      <a
        hlmBtn
        variant="ghost"
        size="icon"
        routerLink="/app/help"
        [fragment]="section()"
        [attr.aria-label]="'help.context' | translate"
        [attr.title]="'help.context' | translate"
        data-help-link
      >
        <ng-icon name="lucideCircleHelp" size="18" aria-hidden="true" />
      </a>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpLink {
  readonly section = input.required<HelpSectionId>();
  readonly labelKey = input<string | null>(null);
}
