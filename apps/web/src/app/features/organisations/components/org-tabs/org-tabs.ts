import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

/** The two pages of an organisation, as tabs (the style of a project's tabs). */
@Component({
  selector: 'mt-org-tabs',
  imports: [RouterLink, RouterLinkActive, TranslatePipe],
  template: `
    <nav
      class="mt-tabs mb-6"
      [attr.aria-label]="'organisations.tabs.label' | translate"
    >
      @for (tab of tabs; track tab) {
        <a
          class="mt-tab"
          routerLinkActive="mt-tab-active"
          [routerLink]="['/app/organisations', orgId(), tab]"
          [attr.data-tab]="tab"
        >
          {{ 'organisations.tabs.' + tab | translate }}
        </a>
      }
    </nav>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrgTabs {
  readonly orgId = input.required<string>();
  protected readonly tabs = ['projects', 'members'] as const;
}
