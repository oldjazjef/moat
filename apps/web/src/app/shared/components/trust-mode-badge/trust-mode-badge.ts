import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShieldCheck } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import type { TrustMode } from '../../../core/api/project.types';
import { HelpLink } from '../../../features/help/components/help-link';
import { TRUST_STRENGTH, trustKeys } from './trust-modes';

/**
 * A gate's trust mode (§2.9, FR-72): the label as a badge with its "?" into the guide; with
 * `detailed`, also what the mode means and the "Wenn Moat Cloud gehackt wird …" sentence, so the
 * guarantee stays honest (§1.5). Shows the mode in force, never a stronger one.
 */
@Component({
  selector: 'mt-trust-mode-badge',
  imports: [NgIcon, TranslatePipe, HlmBadge, HelpLink],
  providers: [provideIcons({ lucideShieldCheck })],
  template: `
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-1">
        <span
          hlmBadge
          variant="outline"
          data-trust-mode
          [attr.data-mode]="mode()"
          [class.mt-trust-strong]="strength() === 'strong'"
          [class.mt-trust-weak]="strength() === 'weak'"
        >
          <ng-icon name="lucideShieldCheck" size="14" aria-hidden="true" />
          {{ keys.label(mode()) | translate }}
        </span>
        <mt-help-link section="trust" />
      </div>
      @if (detailed()) {
        <p class="text-sm" data-trust-short>
          {{ keys.short(mode()) | translate }}
        </p>
        <p class="text-muted-foreground text-sm" data-trust-if-hacked>
          {{ 'trust.ifHackedPrefix' | translate }}
          {{ keys.ifHacked(mode()) | translate }}
        </p>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrustModeBadge {
  readonly mode = input.required<TrustMode>();
  readonly detailed = input(false);
  protected readonly keys = trustKeys;
  protected strength(): 'strong' | 'weak' {
    return TRUST_STRENGTH[this.mode()];
  }
}
