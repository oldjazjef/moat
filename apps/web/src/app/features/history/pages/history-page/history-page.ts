import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmTableImports } from '@moat/ui/table';
import { HelpLink } from '../../../help/components/help-link';
import { HistoryPageService } from './history-page.service';

@Component({
  selector: 'mt-history-page',
  imports: [
    DatePipe,
    TranslatePipe,
    HelpLink,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmTableImports,
  ],
  providers: [HistoryPageService],
  templateUrl: './history-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryPage {
  protected readonly service = inject(HistoryPageService);
}
