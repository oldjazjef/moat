import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFolderPlus,
  lucideRefreshCw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { PageHeader } from '../../../../shared/components/page-header';
import { RichText } from '../../../../shared/components/rich-text';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { HelpLink } from '../../../help/components/help-link';
import { ProjectsPageService } from './projects-page.service';

@Component({
  selector: 'mt-projects-page',
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
    ProjectsPageService,
    provideIcons({ lucideFolderPlus, lucideRefreshCw, lucideTriangleAlert }),
  ],
  templateUrl: './projects-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectsPage {
  protected readonly service = inject(ProjectsPageService);
}
