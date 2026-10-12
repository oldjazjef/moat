import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmTableImports } from '@moat/ui/table';
import { HelpLink } from '../../../help/components/help-link';
import { RouteForm } from '../../components/route-form';
import { UpstreamForm } from '../../components/upstream-form';
import { RoutesPageService } from './routes-page.service';

@Component({
  selector: 'mt-routes-page',
  imports: [
    RouterLink,
    TranslatePipe,
    HelpLink,
    RouteForm,
    UpstreamForm,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmTableImports,
  ],
  providers: [RoutesPageService],
  templateUrl: './routes-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RoutesPage {
  protected readonly service = inject(RoutesPageService);
  protected readonly resource = this.service.resource;
}
