import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { ProjectRemoveButton } from '../../../projects/components/project-remove-button';
import { LockBadge } from '../../../../shared/components/lock-badge';
import { RichText } from '../../../../shared/components/rich-text';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { HelpLink } from '../../../help/components/help-link';
import { OverviewPageService } from './overview-page.service';

@Component({
  selector: 'mt-overview-page',
  imports: [
    RouterLink,
    TranslatePipe,
    TrustModeBadge,
    LockBadge,
    RichText,
    HelpLink,
    HlmBadge,
    ProjectRemoveButton,
    ...HlmButtonImports,
    ...HlmCardImports,
  ],
  providers: [OverviewPageService],
  templateUrl: './overview-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPage {
  protected readonly service = inject(OverviewPageService);
  protected readonly resource = this.service.resource;
}
