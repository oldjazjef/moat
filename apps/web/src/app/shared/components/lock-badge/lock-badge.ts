import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLock } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HelpLink } from '../../../features/help/components/help-link';

/**
 * "Gesperrt" for a gate or an environment that moat.yaml locks, with its "?" into the guide.
 * Shows nothing for an unlocked one: being active is the normal case.
 */
@Component({
  selector: 'mt-lock-badge',
  imports: [NgIcon, TranslatePipe, HlmBadge, HelpLink],
  providers: [provideIcons({ lucideLock })],
  template: `
    @if (locked()) {
      <span class="inline-flex items-center gap-1">
        <span hlmBadge variant="destructive" data-locked>
          <ng-icon name="lucideLock" size="12" aria-hidden="true" />
          {{ 'locks.locked' | translate }}
        </span>
        <mt-help-link section="environments" />
      </span>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LockBadge {
  readonly locked = input.required<boolean>();
}
