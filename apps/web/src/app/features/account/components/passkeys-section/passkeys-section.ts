import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
} from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { apiErrorKey } from '../../../../core/auth/api-error';
import { PasskeysSectionService } from './passkeys-section.service';

@Component({
  selector: 'mt-passkeys-section',
  imports: [
    ReactiveFormsModule,
    NgIcon,
    TranslatePipe,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [PasskeysSectionService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './passkeys-section.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PasskeysSection implements OnInit {
  protected readonly service = inject(PasskeysSectionService);
  protected readonly errorKey = apiErrorKey;

  ngOnInit(): void {
    void this.service.load();
  }
}
