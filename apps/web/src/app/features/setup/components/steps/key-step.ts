import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import {
  desktopBridge,
  type SigningKeyResult,
  type SigningKeyStatus,
} from '../../../../core/desktop/desktop-bridge';
import { LanguageService } from '../../../../core/i18n/language.service';
import { RichText } from '../../../../shared/components/rich-text';
import { provideSetupStep, SetupStepComponent } from '../setup-step';

/** `setup.key.notices.<notice>` */
export const KEY_NOTICES = ['unreadable', 'failed', 'required'] as const;
type Notice = (typeof KEY_NOTICES)[number] | null;

/**
 * FR-73, step «Signaturschlüssel»: the key file the desktop signs with (DT-15). A new one is
 * created in the main process's key window (the passphrase is typed only there), an existing one
 * chosen in its file dialog. The page sees only the public half: the fingerprint, and the public
 * key the gate's install command needs.
 */
@Component({
  selector: 'mt-setup-key-step',
  imports: [TranslatePipe, RichText, ...HlmButtonImports],
  providers: [provideSetupStep(() => KeyStep)],
  template: `
    @if (!desktop) {
      <p class="mt-note" data-key-cli>
        <mt-rich-text [text]="'setup.key.cli' | translate" />
      </p>
    } @else {
      @if (status(); as current) {
        @if (current.status === 'ready') {
          <dl class="mt-facts" data-key-ready>
            <dt>{{ 'setup.key.fingerprint' | translate }}</dt>
            <dd class="mt-code" data-key-fingerprint>
              {{ current.key.fingerprint }}
            </dd>
            <dt>{{ 'setup.key.publicKey' | translate }}</dt>
            <dd class="mt-code" data-key-public>{{ current.key.publicKey }}</dd>
          </dl>
          <p class="text-muted-foreground mt-3 text-sm">
            {{ 'setup.key.readyHint' | translate }}
          </p>
        } @else if (current.status === 'unreadable') {
          <p class="text-destructive text-sm" role="alert" data-key-unreadable>
            {{ 'setup.key.unreadable' | translate }}
          </p>
        } @else {
          <p class="text-sm" data-key-none>
            {{ 'setup.key.none' | translate }}
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
          {{ 'setup.key.create' | translate }}
        </button>
        <button
          hlmBtn
          variant="outline"
          type="button"
          data-key-choose
          [disabled]="busy()"
          (click)="choose()"
        >
          {{ 'setup.key.choose' | translate }}
        </button>
      </div>
      <p class="text-muted-foreground mt-3 text-sm">
        {{ 'setup.key.backup' | translate }}
      </p>
      @if (notice(); as code) {
        <p class="text-destructive mt-3 text-sm" role="alert" data-key-notice>
          {{ 'setup.key.notices.' + code | translate }}
        </p>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyStep extends SetupStepComponent {
  private readonly bridge = desktopBridge();
  private readonly language = inject(LanguageService);
  protected readonly desktop = this.bridge !== null;
  protected readonly status = signal<SigningKeyStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  constructor() {
    super();
    void this.refresh();
  }

  protected async create(): Promise<void> {
    await this.run(
      () => this.bridge?.key.create(this.language.locale()) ?? cancelled(),
    );
  }

  protected async choose(): Promise<void> {
    await this.run(() => this.bridge?.key.choose() ?? cancelled());
  }

  /** «Weiter» needs a usable key; without one, «Später». In a browser there is nothing to do. */
  async submit(): Promise<boolean> {
    if (!this.desktop) return true;
    await this.refresh();
    if (this.status()?.status === 'ready') return true;
    this.notice.set('required');
    return false;
  }

  private async run(action: () => Promise<SigningKeyResult>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const result = await action();
      if (result.status === 'chosen' || result.status === 'created') {
        this.status.set({ status: 'ready', key: result.key });
      } else if (result.status === 'unreadable' || result.status === 'failed') {
        this.notice.set(result.status);
      }
    } catch {
      this.notice.set('failed');
    } finally {
      this.busy.set(false);
    }
  }

  private async refresh(): Promise<void> {
    if (this.bridge === null) return;
    try {
      this.status.set(await this.bridge.key.status());
    } catch {
      this.status.set({ status: 'unreadable' });
    }
  }
}

function cancelled(): Promise<SigningKeyResult> {
  return Promise.resolve({ status: 'cancelled' });
}
