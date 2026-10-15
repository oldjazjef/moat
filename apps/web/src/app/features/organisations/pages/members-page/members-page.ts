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
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { HlmTableImports } from '@moat/ui/table';
import {
  type MemberView,
  ROLES,
  type Role,
} from '../../../../core/auth/account.types';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PageHeader } from '../../../../shared/components/page-header';
import { RowActions } from '../../../../shared/components/row-actions';
import { HelpLink } from '../../../help/components/help-link';
import { OrgTabs } from '../../components/org-tabs';
import { OrgScope } from '../../org-scope';
import { MembersPageService } from './members-page.service';

@Component({
  selector: 'mt-members-page',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    PageHeader,
    RowActions,
    HelpLink,
    OrgTabs,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
    ...HlmTableImports,
  ],
  providers: [
    OrgScope,
    MembersPageService,
    provideIcons({ lucideTriangleAlert }),
  ],
  templateUrl: './members-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MembersPage {
  /** The route's `:orgId`. */
  readonly orgId = input.required<string>();
  protected readonly service = inject(MembersPageService);
  protected readonly errorKey = apiErrorKey;
  protected readonly removeAction = [
    { id: 'remove', labelKey: 'members.remove', destructive: true },
  ] as const;

  constructor() {
    inject(OrgScope).bind(this.orgId);
  }

  protected async changeRole(
    member: MemberView,
    select: HTMLSelectElement,
  ): Promise<void> {
    const role = ROLES.find((candidate) => candidate === select.value);
    if (role !== undefined) await this.service.changeRole(member, role as Role);
    // A refused change leaves the list as it was: show the role that is in force.
    const now = this.service.members
      .value()
      ?.members.find((m) => m.accountId === member.accountId);
    select.value = now?.role ?? member.role;
  }
}
