import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { OrgTabs } from '../../components/org-tabs';
import { ProjectTabs } from '../../components/project-tabs';
import { OrgScope } from '../../org-scope';
import { ProjectConfigPageService } from './project-config-page.service';

@Component({
  selector: 'mt-project-config-page',
  imports: [
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    OrgTabs,
    ProjectTabs,
    ...HlmButtonImports,
  ],
  providers: [
    OrgScope,
    ProjectConfigPageService,
    provideIcons({ lucideTriangleAlert }),
  ],
  templateUrl: './project-config-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectConfigPage {
  readonly orgId = input.required<string>();
  readonly projectId = input.required<string>();
  protected readonly service = inject(ProjectConfigPageService);
  protected readonly errorKey = apiErrorKey;

  constructor() {
    inject(OrgScope).bind(this.orgId);
    this.service.bind(this.projectId);
  }

  protected onInput(event: Event): void {
    this.service.edit((event.target as HTMLTextAreaElement).value);
  }
}
