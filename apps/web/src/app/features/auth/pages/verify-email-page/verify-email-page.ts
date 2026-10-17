import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { AuthFrame } from '../../components/auth-frame';
import { VerifyEmailPageService } from './verify-email-page.service';

@Component({
  selector: 'mt-verify-email-page',
  imports: [
    RouterLink,
    NgIcon,
    TranslatePipe,
    AuthFrame,
    ...HlmButtonImports,
    ...HlmCardImports,
  ],
  providers: [VerifyEmailPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './verify-email-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerifyEmailPage {
  protected readonly service = inject(VerifyEmailPageService);
  protected readonly errorKey = apiErrorKey;
}
