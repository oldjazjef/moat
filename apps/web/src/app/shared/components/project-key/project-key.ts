import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import {
  desktopBridge,
  type SigningKeyResult,
  type SigningKeyStatus,
} from '../../../core/desktop/desktop-bridge';
import { LanguageService } from '../../../core/i18n/language.service';
import { RichText } from '../rich-text';

/** `projectKey.notices.<notice>` */
export const PROJECT_KEY_NOTICES = [
  'unreadable',
  'failed',
  'required',
] as const;
export type ProjectKeyNotice = (typeof PROJECT_KEY_NOTICES)[number];

/**
 * A project's signing key (DT-15): every project has its own `.moatkey` file, chosen or created
 * here for the project `projectId`. A new key is created in the main process's key window (the
 * passphrase is typed only there), an existing one chosen in its file dialog. The page sees only
 * the public half: the fingerprint, and the public key the gate's install command needs. Used by
 * the setup wizard and the settings.
 */
@Component({
  selector: 'mt-project-key',
  imports: [TranslatePipe, RichText, ...HlmButtonImports],
  template: `
    @if (!desktop) {
      <p class="mt-note" data-key-cli>
        <mt-rich-text [text]="'projectKey.cli' | translate" />
      </p>
    } @else if (projectId() === null) {
      <p class="mt-note" data-key-no-project>
        {{ 'projectKey.noProject' | translate }}
      </p>
    } @else {
      @if (status(); as current) {
        @if (current.status === 'ready') {
          <dl class="mt-facts" data-key-ready>
            <dt>{{ 'projectKey.fingerprint' | translate }}</dt>
            <dd class="mt-code" data-key-fingerprint>
              {{ current.key.fingerprint }}
            </dd>
            <dt>{{ 'projectKey.publicKey' | translate }}</dt>
            <dd class="mt-code break-all" data-key-public>
              {{ current.key.publicKey }}
            </dd>
          </dl>
          @if (current.previous; as previous) {
            <p class="text-muted-foreground mt-2 text-sm" data-key-rotation>
              {{
                'projectKey.rotation'
                  | translate: { fingerprint: previous.fingerprint }
              }}
            </p>
          }
          <p class="text-muted-foreground mt-3 text-sm">
            {{ 'projectKey.readyHint' | translate }}
          </p>
        } @else if (current.status === 'unreadable') {
          <p class="text-destructive text-sm" role="alert" data-key-unreadable>
            {{ 'projectKey.unreadable' | translate }}
          </p>
        } @else {
          <p class="text-sm" data-key-none>
            {{ 'projectKey.none' | translate }}
          </p>
        }
      }
      <div class="mt-4 flex flex-wrap gap-2">
        <button
          hlmBtn
          type="button"
          data-key-create
          [variant]="status()?.status === 'ready' ? 'outline' : 'default'"
          [disabled]="busy()"
          (click)="create()"
        >
          {{ 'projectKey.create' | translate }}
        </button>
        <button
          hlmBtn
          variant="outline"
          type="button"
          data-key-choose
          [disabled]="busy()"
          (click)="choose()"
        >
          {{ 'projectKey.choose' | translate }}
        </button>
      </div>
      @if (status()?.status === 'ready') {
        <p class="text-muted-foreground mt-3 text-sm" data-key-replace-hint>
          {{ 'projectKey.replaceHint' | translate }}
        </p>
      }
      <p class="text-muted-foreground mt-3 text-sm">
        {{ 'projectKey.backup' | translate }}
      </p>
      @if (notice(); as code) {
        <p class="text-destructive mt-3 text-sm" role="alert" data-key-notice>
          {{ 'projectKey.notices.' + code | translate }}
        </p>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectKey {
  /** The project whose key this is; null: none chosen yet (the wizard before «Erstes Projekt»). */
  readonly projectId = input.required<string | null>();

  private readonly bridge = desktopBridge();
  private readonly language = inject(LanguageService);
  protected readonly desktop = this.bridge !== null;
  readonly status = signal<SigningKeyStatus | null>(null);
  protected readonly busy = signal(false);
  readonly notice = signal<ProjectKeyNotice | null>(null);

  constructor() {
    // Another project: its own key.
    effect(() => {
      this.projectId();
      this.notice.set(null);
      void this.refresh();
    });
  }

  protected async create(): Promise<void> {
    const id = this.projectId();
    if (id === null) return;
    await this.run(
      () => this.bridge?.key.create(id, this.language.locale()) ?? cancelled(),
    );
  }

  protected async choose(): Promise<void> {
    const id = this.projectId();
    if (id === null) return;
    await this.run(() => this.bridge?.key.choose(id) ?? cancelled());
  }

  /** Whether the project has a key that opens; reads it again first. */
  async ready(): Promise<boolean> {
    await this.refresh();
    return this.status()?.status === 'ready';
  }

  async refresh(): Promise<void> {
    const id = this.projectId();
    if (this.bridge === null) return;
    if (id === null) {
      this.status.set(null);
      return;
    }
    try {
      this.status.set(await this.bridge.key.status(id));
    } catch {
      this.status.set({ status: 'unreadable' });
    }
  }

  private async run(action: () => Promise<SigningKeyResult>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const result = await action();
      if (result.status === 'chosen' || result.status === 'created') {
        // Read back: a replaced key shows the rotation it started (SEC-08).
        await this.refresh();
      } else if (result.status === 'unreadable' || result.status === 'failed') {
        this.notice.set(result.status);
      }
    } catch {
      this.notice.set('failed');
    } finally {
      this.busy.set(false);
    }
  }
}

function cancelled(): Promise<SigningKeyResult> {
  return Promise.resolve({ status: 'cancelled' });
}
