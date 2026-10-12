import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFolderOpen,
  lucideRefreshCw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HelpLink } from '../../../help/components/help-link';
import { PageHeader } from '../../../../shared/components/page-header';
import { RichText } from '../../../../shared/components/rich-text';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { OverviewPageService } from './overview-page.service';

@Component({
  selector: 'mt-overview-page',
  imports: [
    RouterLink,
    NgIcon,
    TranslatePipe,
    PageHeader,
    RichText,
    HelpLink,
    TrustModeBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
  ],
  providers: [
    OverviewPageService,
    provideIcons({ lucideFolderOpen, lucideRefreshCw, lucideTriangleAlert }),
  ],
  templateUrl: './overview-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {
  protected readonly service = inject(OverviewPageService);
  protected readonly resource = this.service.resource;
}
