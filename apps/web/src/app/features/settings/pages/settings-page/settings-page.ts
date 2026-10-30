import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmSkeletonImports } from '@moat/ui/skeleton';
import { UpdateService } from '../../../../core/desktop/update.service';
import { PageHeader } from '../../../../shared/components/page-header';
import { ProjectKey } from '../../../../shared/components/project-key';
import {
  type RowAction,
  RowActions,
} from '../../../../shared/components/row-actions';
import { HelpLink } from '../../../help/components/help-link';
import { SettingsPageService } from './settings-page.service';

@Component({
  selector: 'mt-settings-page',
  imports: [
    RouterLink,
    TranslatePipe,
    PageHeader,
    ProjectKey,
    RowActions,
    HelpLink,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmSkeletonImports,
  ],
  providers: [SettingsPageService],
  templateUrl: './settings-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  protected readonly service = inject(SettingsPageService);
  protected readonly updates = inject(UpdateService);

  protected readonly tokenName = signal('');
  protected readonly tokenActions: readonly RowAction[] = [
    { id: 'revoke', labelKey: 'settings.mcp.revoke', destructive: true },
  ];

  /** The two snippets for an MCP client; `<TOKEN>` stands for the token shown once. */
  protected readonly snippets = computed(() => {
    const endpoint = this.service.mcp()?.endpoint ?? '';
    return {
      claudeCode: `claude mcp add --transport http moat ${endpoint} --header "Authorization: Bearer <TOKEN>"`,
      json: JSON.stringify(
        {
          mcpServers: {
            moat: {
              command: 'npx',
              args: [
                '-y',
                'mcp-remote',
                endpoint,
                '--header',
                'Authorization: Bearer <TOKEN>',
              ],
            },
          },
        },
        null,
        2,
      ),
    };
  });

  protected onMcpEnabled(event: Event): void {
    void this.service.setMcpEnabled((event.target as HTMLInputElement).checked);
  }

  protected onPort(event: Event): void {
    void this.service.setMcpPort((event.target as HTMLInputElement).value);
  }

  protected onTokenName(event: Event): void {
    this.tokenName.set((event.target as HTMLInputElement).value);
  }

  protected async createToken(): Promise<void> {
    if (await this.service.createToken(this.tokenName()))
      this.tokenName.set('');
  }

  protected onTokenAction(id: string, action: string): void {
    if (action === 'revoke') void this.service.revokeToken(id);
  }

  protected onAuto(event: Event): void {
    void this.updates.setAuto((event.target as HTMLInputElement).checked);
  }
}
