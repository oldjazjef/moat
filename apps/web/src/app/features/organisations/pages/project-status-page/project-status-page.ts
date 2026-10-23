import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { OrgTabs } from '../../components/org-tabs';
import { ProjectTabs } from '../../components/project-tabs';
import { OrgScope } from '../../org-scope';
import { ProjectStatusPageService } from './project-status-page.service';

@Component({
  selector: 'mt-project-status-page',
  imports: [
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    OrgTabs,
    ProjectTabs,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
  ],
  providers: [
    OrgScope,
    ProjectStatusPageService,
    provideIcons({ lucideTriangleAlert }),
  ],
  templateUrl: './project-status-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectStatusPage {
  readonly orgId = input.required<string>();
  readonly projectId = input.required<string>();
  protected readonly service = inject(ProjectStatusPageService);

  constructor() {
    inject(OrgScope).bind(this.orgId);
    this.service.bind(this.projectId);
  }
}
