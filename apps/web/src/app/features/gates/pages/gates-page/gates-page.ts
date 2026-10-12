import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRefreshCw, lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HelpLink } from '../../../help/components/help-link';
import { PageHeader } from '../../../../shared/components/page-header';
import { RichText } from '../../../../shared/components/rich-text';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { GatesPageService } from './gates-page.service';

@Component({
  selector: 'mt-gates-page',
  imports: [
    RouterLink,
    NgIcon,
    TranslatePipe,
    PageHeader,
    RichText,
    HelpLink,
    TrustModeBadge,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
  ],
  providers: [
    GatesPageService,
    provideIcons({ lucideRefreshCw, lucideTriangleAlert }),
  ],
  templateUrl: './gates-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GatesPage {
  protected readonly service = inject(GatesPageService);
  protected readonly resource = this.service.resource;
}
