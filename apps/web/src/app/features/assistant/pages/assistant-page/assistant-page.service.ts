import {
  HttpClient,
  HttpErrorResponse,
  httpResource,
} from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import {
  ASSISTANT_ERRORS,
  type AssistantError,
  type AssistantStatus,
  type Conversation,
  type ConversationSummary,
  type Proposal,
} from '../../../../core/api/assistant.types';
import type { ProjectSummary } from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { desktopBridge } from '../../../../core/desktop/desktop-bridge';

/** `assistant.decisionErrors.<code>`: why «Ausführen»/«Verwerfen» did nothing. */
export const DECISION_ERRORS = ['already_decided', 'failed'] as const;
export type DecisionError = (typeof DECISION_ERRORS)[number];

/**
 * «Assistent» (Moat Desktop): conversations with the AI provider the person set up, and the
 * proposals to decide — the chat's and those of MCP clients. Nothing changes moat.yaml until
 * «Ausführen» here; signing, sealing and deploying stay where they were.
 */
@Injectable()
export class AssistantPageService {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly bridge = desktopBridge();

  readonly status = httpResource<AssistantStatus>(() =>
    apiUrl('/assistant/status'),
  );
  readonly conversations = httpResource<readonly ConversationSummary[]>(() =>
    apiUrl('/assistant/conversations'),
  );
  readonly proposals = httpResource<readonly Proposal[]>(() =>
    apiUrl('/assistant/proposals'),
  );
  readonly projects = httpResource<readonly ProjectSummary[]>(() =>
    apiUrl('/projects'),
  );

  readonly configured = computed(
    () => this.status.hasValue() && this.status.value().configured,
  );
  /** The desktop shell offers the provider window. */
  readonly canSetUp = this.bridge?.assistant !== undefined;

  readonly current = signal<Conversation | null>(null);
  /** The project the questions are about (context for the model); '' = none. */
  readonly projectId = signal('');
  readonly asking = signal(false);
  readonly error = signal<AssistantError | null>(null);
  /** The provider's own words for the last error, redacted by the API. */
  readonly errorDetail = signal<string | null>(null);
  readonly decisionError = signal<DecisionError | null>(null);
  readonly deciding = signal<string | null>(null);

  /** Proposals of MCP clients still waiting: they have no conversation to show them in. */
  readonly mcpPending = computed(() =>
    this.proposals.hasValue()
      ? this.proposals
          .value()
          .filter((p) => p.source === 'mcp' && p.status === 'pending')
      : [],
  );

  proposal(id: string): Proposal | null {
    return this.current()?.proposals.find((p) => p.id === id) ?? null;
  }

  async setUpProvider(): Promise<void> {
    if (this.bridge?.assistant === undefined) return;
    await this.bridge.assistant.openProvider(
      this.translate.getCurrentLang() ?? '',
    );
    this.status.reload();
  }

  async open(id: string): Promise<void> {
    this.error.set(null);
    try {
      this.current.set(
        await firstValueFrom(
          this.http.get<Conversation>(
            apiUrl(`/assistant/conversations/${encodeURIComponent(id)}`),
          ),
        ),
      );
    } catch {
      this.current.set(null);
      this.conversations.reload();
    }
  }

  async startNew(): Promise<void> {
    this.error.set(null);
    const created = await firstValueFrom(
      this.http.post<Conversation>(apiUrl('/assistant/conversations'), {}),
    );
    this.current.set(created);
    this.conversations.reload();
  }

  async remove(id: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.delete(
          apiUrl(`/assistant/conversations/${encodeURIComponent(id)}`),
        ),
      );
    } catch {
      // Already gone.
    }
    if (this.current()?.id === id) this.current.set(null);
    this.conversations.reload();
    this.proposals.reload();
  }

  /** Sends the question; true when it got an answer (the field may be cleared). */
  async ask(text: string): Promise<boolean> {
    const question = text.trim();
    if (question === '' || this.asking()) return false;
    this.asking.set(true);
    this.error.set(null);
    this.errorDetail.set(null);
    try {
      if (this.current() === null) await this.startNew();
      const id = this.current()?.id ?? '';
      const answer = await firstValueFrom(
        this.http.post<Conversation>(
          apiUrl(`/assistant/conversations/${encodeURIComponent(id)}/messages`),
          {
            text: question,
            ...(this.projectId() === '' ? {} : { projectId: this.projectId() }),
            locale: this.translate.getCurrentLang() === 'en' ? 'en' : 'de-CH',
          },
        ),
      );
      this.current.set(answer);
      this.conversations.reload();
      this.proposals.reload();
      return true;
    } catch (error) {
      this.error.set(errorOf(error));
      this.errorDetail.set(detailOf(error));
      if (errorOf(error) === 'not_configured') this.status.reload();
      return false;
    } finally {
      this.asking.set(false);
    }
  }

  confirm(id: string): Promise<void> {
    return this.decide(id, 'confirm');
  }

  cancel(id: string): Promise<void> {
    return this.decide(id, 'cancel');
  }

  private async decide(id: string, how: 'confirm' | 'cancel'): Promise<void> {
    if (this.deciding() !== null) return;
    this.deciding.set(id);
    this.decisionError.set(null);
    try {
      await firstValueFrom(
        this.http.post<Proposal>(
          apiUrl(`/assistant/proposals/${encodeURIComponent(id)}/${how}`),
          {},
        ),
      );
    } catch (error) {
      this.decisionError.set(
        error instanceof HttpErrorResponse && error.status === 409
          ? 'already_decided'
          : 'failed',
      );
    } finally {
      this.deciding.set(null);
    }
    this.proposals.reload();
    const current = this.current();
    if (current !== null) await this.open(current.id);
  }
}

function errorOf(error: unknown): AssistantError {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  const code = (error.error as { error?: unknown } | null)?.error;
  return typeof code === 'string' &&
    (ASSISTANT_ERRORS as readonly string[]).includes(code)
    ? (code as AssistantError)
    : 'failed';
}

function detailOf(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse) || error.status !== 502)
    return null;
  const details = (error.error as { details?: Record<string, unknown> } | null)
    ?.details;
  if (details === undefined || details === null) return null;
  const parts = [
    typeof details['status'] === 'number' ? `HTTP ${details['status']}` : null,
    typeof details['providerMessage'] === 'string'
      ? details['providerMessage']
      : null,
    typeof details['cause'] === 'string' ? details['cause'] : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}
