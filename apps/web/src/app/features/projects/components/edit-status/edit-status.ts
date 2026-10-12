import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { RichText } from '../../../../shared/components/rich-text';

/**
 * The outcome of the last edit of moat.yaml, above the workspace's tabs: saved (and that a gate
 * sees it only with the next bundle), or why it was refused.
 */
@Component({
  selector: 'mt-edit-status',
  imports: [TranslatePipe, RichText, ...HlmButtonImports],
  template: `
    @if (edits.outcome(); as outcome) {
      <div
        class="mt-note mb-6"
        [attr.role]="outcome.kind === 'error' ? 'alert' : 'status'"
        [attr.data-edit-outcome]="outcome.kind"
      >
        <p class="flex-1">
          @if (outcome.kind === 'saved') {
            <mt-rich-text [text]="'edit.saved' | translate" />
          } @else {
            <span class="text-destructive">
              {{ 'edit.errors.' + outcome.code | translate }}
            </span>
          }
        </p>
        <button
          hlmBtn
          variant="ghost"
          size="sm"
          type="button"
          data-edit-dismiss
          (click)="edits.dismiss()"
        >
          {{ 'edit.dismiss' | translate }}
        </button>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditStatus {
  protected readonly edits = inject(ProjectEdits);
}
