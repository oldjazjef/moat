import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { ssoResultOf } from '../../../../core/auth/account.types';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { AuthFrame } from '../../components/auth-frame';
import { LoginPageService } from './login-page.service';

@Component({
  selector: 'mt-login-page',
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
  providers: [LoginPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './login-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  protected readonly service = inject(LoginPageService);
  protected readonly errorKey = apiErrorKey;
  /** `?sso=` — why the way back from a provider ended here (a fixed list; anything else is ignored). */
  readonly sso = input<string>();
  protected readonly ssoError = computed(() => {
    const code = ssoResultOf(this.sso());
    return code === null || code === 'linked' ? null : code;
  });
}
