import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import {
  DRY_RUN_METHODS,
  SECRET_PLACEHOLDER,
} from '../../../../core/api/dry-run.types';
import { RichText } from '../../../../shared/components/rich-text';
import { HelpLink } from '../../../help/components/help-link';
import { ConsolePageService } from './console-page.service';

@Component({
  selector: 'mt-console-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    TranslatePipe,
    HelpLink,
    RichText,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [ConsolePageService],
  templateUrl: './console-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsolePage {
  protected readonly service = inject(ConsolePageService);
  protected readonly resource = this.service.resource;
  protected readonly methods = DRY_RUN_METHODS;
  protected readonly placeholder = SECRET_PLACEHOLDER;

  protected headerList(
    headers: Readonly<Record<string, string>>,
  ): [string, string][] {
    return Object.entries(headers);
  }
}
