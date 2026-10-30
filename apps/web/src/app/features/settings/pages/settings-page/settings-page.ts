import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmSkeletonImports } from '@moat/ui/skeleton';
import { PageHeader } from '../../../../shared/components/page-header';
import { ProjectKey } from '../../../../shared/components/project-key';
import { HelpLink } from '../../../help/components/help-link';
import { SettingsPageService } from './settings-page.service';

@Component({
  selector: 'mt-settings-page',
  imports: [
    RouterLink,
    TranslatePipe,
    PageHeader,
    ProjectKey,
    HelpLink,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmSkeletonImports,
  ],
  providers: [SettingsPageService],
  templateUrl: './settings-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  protected readonly service = inject(SettingsPageService);
}
