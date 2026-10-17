import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PASSWORD_MIN } from '../../../../core/auth/credentials.schema';
import { AuthFrame } from '../../components/auth-frame';
import { ResetPasswordPageService } from './reset-password-page.service';

@Component({
  selector: 'mt-reset-password-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    NgIcon,
    TranslatePipe,
    AuthFrame,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [ResetPasswordPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './reset-password-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResetPasswordPage {
  protected readonly service = inject(ResetPasswordPageService);
  protected readonly errorKey = apiErrorKey;
  protected readonly min = PASSWORD_MIN;
}
