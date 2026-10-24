import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { ssoResultOf } from '../../../../core/auth/account.types';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { SsoSectionService } from './sso-section.service';

@Component({
  selector: 'mt-sso-section',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [SsoSectionService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './sso-section.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SsoSection {
  /** `?sso=` from the way back, a fixed list. */
  readonly result = input<string | undefined>();
  protected readonly service = inject(SsoSectionService);
  protected readonly errorKey = apiErrorKey;
  protected readonly outcome = computed(() => ssoResultOf(this.result()));
  /** The section is worth showing when a provider exists or one is linked already. */
  protected readonly visible = computed(
    () =>
      this.service.linked().length > 0 ||
      (this.service.providers.hasValue() &&
        this.service.providers.value().providers.length > 0),
  );
}
