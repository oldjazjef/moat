import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

/** The two pages of a Cloud project, as tabs: its gates and its moat.yaml. */
@Component({
  selector: 'mt-project-tabs',
  imports: [RouterLink, RouterLinkActive, TranslatePipe],
  template: `
    <nav
      class="mt-tabs mb-6"
      [attr.aria-label]="'projectTabs.label' | translate"
    >
      @for (tab of tabs; track tab.id) {
        <a
          class="mt-tab"
          routerLinkActive="mt-tab-active"
          [routerLinkActiveOptions]="{ exact: true }"
          [routerLink]="tab.link(orgId(), projectId())"
          [attr.data-tab]="tab.id"
        >
          {{ 'projectTabs.' + tab.id | translate }}
        </a>
      }
    </nav>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectTabs {
  readonly orgId = input.required<string>();
  readonly projectId = input.required<string>();
  protected readonly tabs = [
    {
      id: 'gates',
      link: (org: string, project: string) => [
        '/app/organisations',
        org,
        'projects',
        project,
      ],
    },
    {
      id: 'config',
      link: (org: string, project: string) => [
        '/app/organisations',
        org,
        'projects',
        project,
        'config',
      ],
    },
  ] as const;
}
