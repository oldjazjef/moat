import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmTableImports } from '@moat/ui/table';
import { HardeningCheck } from '../../../../shared/components/hardening-check';
import { HelpLink } from '../../../help/components/help-link';
import { LockBadge } from '../../../../shared/components/lock-badge';
import { RichText } from '../../../../shared/components/rich-text';
import { RowActions } from '../../../../shared/components/row-actions';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { GatesPageService } from './gates-page.service';

@Component({
  selector: 'mt-gates-page',
  imports: [
    TranslatePipe,
    RichText,
    RowActions,
    HelpLink,
    TrustModeBadge,
    LockBadge,
    HardeningCheck,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmTableImports,
  ],
  providers: [GatesPageService],
  templateUrl: './gates-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GatesPage {
  protected readonly service = inject(GatesPageService);
  protected readonly resource = this.service.resource;
}
