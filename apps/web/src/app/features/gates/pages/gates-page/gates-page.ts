import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HelpLink } from '../../../help/components/help-link';
import { RichText } from '../../../../shared/components/rich-text';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { GatesPageService } from './gates-page.service';

@Component({
  selector: 'mt-gates-page',
  imports: [
    TranslatePipe,
    RichText,
    HelpLink,
    TrustModeBadge,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
  ],
  providers: [GatesPageService],
  templateUrl: './gates-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GatesPage {
  protected readonly service = inject(GatesPageService);
  protected readonly resource = this.service.resource;
}
