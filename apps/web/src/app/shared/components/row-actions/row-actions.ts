import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmDropdownMenuImports } from '@moat/ui/dropdown-menu';

/** One action of a table row or list item; `labelKey` is an i18n key. */
export interface RowAction {
  readonly id: string;
  readonly labelKey: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

/**
 * The actions of one table row or list item, placed in the last cell (`mt-actions-cell`) so they
 * sit at the right edge: a single action is a plain button, two or more open a menu behind a
 * "…" button (CLAUDE.md, Conventions). Each action carries `data-action="<id>"`.
 */
@Component({
  selector: 'mt-row-actions',
  imports: [
    NgIcon,
    TranslatePipe,
    ...HlmButtonImports,
    ...HlmDropdownMenuImports,
  ],
  providers: [provideIcons({ lucideEllipsis })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (actions().length === 1) {
      @let action = actions()[0]!;
      <button
        hlmBtn
        variant="outline"
        size="sm"
        type="button"
        [class.text-destructive]="action.destructive"
        [attr.data-action]="action.id"
        [disabled]="disabled() || action.disabled"
        (click)="run.emit(action.id)"
      >
        {{ action.labelKey | translate }}
      </button>
    } @else if (actions().length > 1) {
      <button
        hlmBtn
        variant="ghost"
        size="icon-sm"
        type="button"
        data-row-actions
        [hlmDropdownMenuTrigger]="menu"
        [attr.aria-label]="'common.actionsFor' | translate: { name: name() }"
        [disabled]="disabled()"
      >
        <ng-icon name="lucideEllipsis" size="16" aria-hidden="true" />
      </button>
      <ng-template #menu>
        <div hlmDropdownMenu data-row-actions-menu>
          @for (action of actions(); track action.id) {
            <button
              hlmDropdownMenuItem
              type="button"
              [variant]="action.destructive ? 'destructive' : 'default'"
              [disabled]="action.disabled === true"
              [attr.data-action]="action.id"
              (triggered)="run.emit(action.id)"
            >
              {{ action.labelKey | translate }}
            </button>
          }
        </div>
      </ng-template>
    }
  `,
})
export class RowActions {
  readonly actions = input.required<readonly RowAction[]>();
  /** The row's name, for the menu button's label ("Aktionen für newsletter"). */
  readonly name = input.required<string>();
  readonly disabled = input(false);
  readonly run = output<string>();
}
