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
import { RegisterPageService } from './register-page.service';

@Component({
  selector: 'mt-register-page',
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
  providers: [RegisterPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './register-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RegisterPage {
  protected readonly service = inject(RegisterPageService);
  protected readonly errorKey = apiErrorKey;
  protected readonly min = PASSWORD_MIN;
}
