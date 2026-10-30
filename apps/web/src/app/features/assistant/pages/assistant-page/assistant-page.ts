import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmSkeletonImports } from '@moat/ui/skeleton';
import { EDIT_ERROR_CODES } from '../../../../core/api/project.types';
import {
  ASSISTANT_TOOLS,
  type Proposal,
} from '../../../../core/api/assistant.types';
import { PageHeader } from '../../../../shared/components/page-header';
import {
  type RowAction,
  RowActions,
} from '../../../../shared/components/row-actions';
import { HelpLink } from '../../../help/components/help-link';
import { AssistantPageService } from './assistant-page.service';

const CONVERSATION_ACTIONS: readonly RowAction[] = [
  {
    id: 'delete',
    labelKey: 'assistant.conversations.delete',
    destructive: true,
  },
];

@Component({
  selector: 'mt-assistant-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    TranslatePipe,
    PageHeader,
    HelpLink,
    RowActions,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmSkeletonImports,
  ],
  providers: [AssistantPageService],
  templateUrl: './assistant-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssistantPage {
  protected readonly service = inject(AssistantPageService);
  /** `?project=<id>`: the project the questions are about, preselected. */
  readonly project = input<string>();

  protected readonly draft = signal('');
  protected readonly conversationActions = CONVERSATION_ACTIONS;
  protected readonly empty = computed(
    () => (this.service.current()?.messages.length ?? 0) === 0,
  );

  constructor() {
    queueMicrotask(() => {
      const id = this.project();
      if (id !== undefined && /^[A-Za-z0-9_-]{22}$/.test(id))
        this.service.projectId.set(id);
    });
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  protected onProject(event: Event): void {
    this.service.projectId.set((event.target as HTMLSelectElement).value);
  }

  protected onKey(event: KeyboardEvent): void {
    // Ctrl/Cmd+Enter sends; Enter alone is a new line.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void this.send();
    }
  }

  protected async send(): Promise<void> {
    if (await this.service.ask(this.draft())) this.draft.set('');
  }

  protected onConversationAction(id: string, action: string): void {
    if (action === 'delete') void this.service.remove(id);
  }

  /** A tool's label; an unknown name (a newer API) is shown as it is. */
  protected toolKey(name: string): string | null {
    return (ASSISTANT_TOOLS as readonly string[]).includes(name)
      ? `assistant.tools.${name}`
      : null;
  }

  protected failureKey(proposal: Proposal): string {
    return proposal.error !== null &&
      (EDIT_ERROR_CODES as readonly string[]).includes(proposal.error)
      ? `edit.errors.${proposal.error}`
      : 'edit.errors.failed';
  }
}
