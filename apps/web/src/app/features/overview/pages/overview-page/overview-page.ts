import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { ProjectRemoveButton } from '../../../projects/components/project-remove-button';
import { TrustModeBadge } from '../../../../shared/components/trust-mode-badge';
import { OverviewPageService } from './overview-page.service';

@Component({
  selector: 'mt-overview-page',
  imports: [
    RouterLink,
    TranslatePipe,
    TrustModeBadge,
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
