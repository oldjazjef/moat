import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PageHeader } from '../../../../shared/components/page-header';
import { RowActions } from '../../../../shared/components/row-actions';
import { HelpLink } from '../../../help/components/help-link';
import { OrganisationsPageService } from './organisations-page.service';

@Component({
  selector: 'mt-organisations-page',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    PageHeader,
    RowActions,
    HelpLink,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
    ...HlmTableImports,
  ],
  providers: [OrganisationsPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './organisations-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrganisationsPage {
  protected readonly service = inject(OrganisationsPageService);
  protected readonly errorKey = apiErrorKey;
  protected readonly openAction = [
    { id: 'open', labelKey: 'organisations.switch' },
  ] as const;
}
