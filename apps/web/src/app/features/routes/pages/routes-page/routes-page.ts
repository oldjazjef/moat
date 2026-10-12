import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRefreshCw, lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmTableImports } from '@moat/ui/table';
import { HelpLink } from '../../../help/components/help-link';
import { PageHeader } from '../../../../shared/components/page-header';
import { RoutesPageService } from './routes-page.service';

@Component({
  selector: 'mt-routes-page',
  imports: [
    RouterLink,
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmTableImports,
  ],
  providers: [
    RoutesPageService,
    provideIcons({ lucideRefreshCw, lucideTriangleAlert }),
  ],
  templateUrl: './routes-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutesPage {
  protected readonly service = inject(RoutesPageService);
  protected readonly resource = this.service.resource;
}
