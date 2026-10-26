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
import { HlmTableImports } from '@moat/ui/table';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { OrgTabs } from '../../components/org-tabs';
import { OrgScope } from '../../org-scope';
import { AuditPageService } from './audit-page.service';

@Component({
  selector: 'mt-audit-page',
  imports: [
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    OrgTabs,
    ...HlmButtonImports,
    ...HlmTableImports,
  ],
  providers: [
    OrgScope,
    AuditPageService,
    provideIcons({ lucideTriangleAlert }),
  ],
  templateUrl: './audit-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuditPage {
  /** The route's `:orgId`. */
  readonly orgId = input.required<string>();
  protected readonly service = inject(AuditPageService);
  protected readonly errorKey = apiErrorKey;

  constructor() {
    inject(OrgScope).bind(this.orgId);
  }
}
