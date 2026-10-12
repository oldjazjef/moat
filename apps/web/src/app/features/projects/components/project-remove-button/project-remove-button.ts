import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { ProjectWorkspaceService } from '../../pages/project-workspace/project-workspace.service';

/**
 * "Aus der Liste entfernen", with a second click to confirm. Removes only the list entry: the
 * project folder and its files stay as they are (said in the confirmation).
 */
@Component({
  selector: 'mt-project-remove-button',
  imports: [TranslatePipe, ...HlmButtonImports],
  template: `
    @if (service.confirmingRemove()) {
      <div class="flex flex-col gap-2 text-sm" data-remove-confirm>
        <p>{{ 'projects.remove.confirm' | translate }}</p>
        <div class="flex flex-wrap gap-2">
          <button
            hlmBtn
            variant="destructive"
            size="sm"
            type="button"
            data-remove-yes
            (click)="service.remove()"
          >
            {{ 'projects.remove.yes' | translate }}
          </button>
          <button
            hlmBtn
            variant="outline"
            size="sm"
            type="button"
            (click)="service.cancelRemove()"
          >
            {{ 'projects.remove.no' | translate }}
          </button>
        </div>
      </div>
    } @else {
      <div>
        <button
          hlmBtn
          variant="outline"
          size="sm"
          type="button"
          data-remove
          (click)="service.remove()"
        >
          {{ 'projects.remove.button' | translate }}
        </button>
      </div>
    }
    @if (service.removeFailed()) {
      <p class="text-destructive text-sm" role="alert">
        {{ 'projects.remove.failed' | translate }}
      </p>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectRemoveButton {
  protected readonly service = inject(ProjectWorkspaceService);
}
