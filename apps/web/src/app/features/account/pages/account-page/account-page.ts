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
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PASSWORD_MIN } from '../../../../core/auth/credentials.schema';
import { PageHeader } from '../../../../shared/components/page-header';
import { RichText } from '../../../../shared/components/rich-text';
import { HelpLink } from '../../../help/components/help-link';
import { PasskeysSection } from '../../components/passkeys-section';
import { AccountPageService } from './account-page.service';

@Component({
  selector: 'mt-account-page',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    PageHeader,
    RichText,
    HelpLink,
    PasskeysSection,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [AccountPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './account-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountPage {
  protected readonly service = inject(AccountPageService);
  protected readonly errorKey = apiErrorKey;
  protected readonly min = PASSWORD_MIN;
}
