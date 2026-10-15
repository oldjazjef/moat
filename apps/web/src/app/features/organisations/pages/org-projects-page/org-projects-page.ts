import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { HlmTableImports } from '@moat/ui/table';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { OrgTabs } from '../../components/org-tabs';
import { OrgScope } from '../../org-scope';
import { OrgProjectsPageService } from './org-projects-page.service';

@Component({
  selector: 'mt-org-projects-page',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    OrgTabs,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
    ...HlmTableImports,
  ],
  providers: [
    OrgScope,
    OrgProjectsPageService,
    provideIcons({ lucideTriangleAlert }),
  ],
  templateUrl: './org-projects-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrgProjectsPage {
  /** The route's `:orgId`. */
  readonly orgId = input.required<string>();
  protected readonly service = inject(OrgProjectsPageService);
  protected readonly errorKey = apiErrorKey;

  constructor() {
    inject(OrgScope).bind(this.orgId);
  }
}
