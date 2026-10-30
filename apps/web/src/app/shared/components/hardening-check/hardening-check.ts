import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShieldAlert } from '@ng-icons/lucide';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { firstValueFrom } from 'rxjs';
import {
  DATA_FOLDER,
  HARDENING_REFUSALS,
  type HardeningCheckReport,
} from '../../../core/api/hardening.types';
import { apiUrl } from '../../../core/config/runtime-env';
import { HelpLink } from '../../../features/help/components/help-link';
import { RichText } from '../rich-text';

/** `hardening.check.notices.<notice>` */
export const HARDENING_NOTICES = [
  ...HARDENING_REFUSALS,
  'folder_format',
  'failed',
] as const;
export type HardeningNotice = (typeof HARDENING_NOTICES)[number];

/** The address typed last, per project and gate (this computer only). */
export const STORAGE_PREFIX = 'moat.hardeningCheck.';

/** The address only: the data folder's random name is part of the hosting's protection. */
interface Remembered {
  readonly url: string;
}

/**
 * The check from outside in Moat Desktop (DT-07, SEC-49): the person names the gate's public URL
 * and its data folder; the API fetches the folder and every data file over the internet, as
 * anyone could, after the main process confirmed the address (T-59). Honest by construction
 * (§1.5): a readable file shows «Unsicher für Secrets», nothing readable shows no level at all —
 * only the gate's own `check` on the server, which also sees the PHP user (SEC-49a), sets one.
 */
@Component({
  selector: 'mt-hardening-check',
  imports: [
    NgIcon,
    TranslatePipe,
    ReactiveFormsModule,
    RichText,
    HelpLink,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [provideIcons({ lucideShieldAlert })],
  template: `
    <form
      class="grid max-w-2xl gap-3"
      [formGroup]="form"
      (ngSubmit)="check()"
      data-hardening-form
    >
      <div class="grid gap-1">
        <label hlmLabel [for]="ids.url">{{
          'hardening.check.url' | translate
        }}</label>
        <input
          hlmInput
          class="mt-code"
          [id]="ids.url"
          formControlName="url"
          data-hardening-url
          [placeholder]="'hardening.check.urlPlaceholder' | translate"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="grid gap-1">
        <label hlmLabel [for]="ids.folder">{{
          'hardening.check.folder' | translate
        }}</label>
        <input
          hlmInput
          class="mt-code"
          [id]="ids.folder"
          formControlName="dataFolder"
          data-hardening-folder
          [placeholder]="'hardening.check.folderPlaceholder' | translate"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="text-muted-foreground text-xs">
          <mt-rich-text [text]="'hardening.check.folderHint' | translate" />
        </p>
      </div>
      <div>
        <button
          hlmBtn
          variant="outline"
          type="submit"
          data-hardening-run
          [disabled]="busy()"
        >
          {{ 'hardening.check.run' | translate }}
        </button>
      </div>
    </form>

    @if (notice(); as code) {
      <p
        class="text-destructive mt-3 text-sm"
        role="alert"
        data-hardening-notice
      >
        <mt-rich-text [text]="'hardening.check.notices.' + code | translate" />
      </p>
    }
    @if (report(); as result) {
      <div
        class="mt-3 flex flex-col gap-2 text-sm"
        role="status"
        data-hardening-result
        [attr.data-result]="result.result"
      >
        @switch (result.result) {
          @case ('reachable') {
            <div class="flex items-center gap-1">
              <span
                hlmBadge
                variant="outline"
                class="mt-trust-weak"
                data-hardening-level="unsafe"
              >
                <ng-icon
                  name="lucideShieldAlert"
                  size="14"
                  aria-hidden="true"
                />
                {{ 'hardening.levels.unsafe' | translate }}
              </span>
              <mt-help-link section="hardening" />
            </div>
            <p>{{ 'hardening.check.reachable' | translate }}</p>
            <ul class="flex flex-wrap gap-2" data-hardening-files>
              @for (file of result.reachable; track file) {
                <li class="mt-code">{{ file }}</li>
              }
            </ul>
            <p class="text-muted-foreground">
              <mt-rich-text
                [text]="'hardening.check.reachableFix' | translate"
              />
            </p>
          }
          @case ('blocked') {
            <p>
              <mt-rich-text
                [text]="
                  'hardening.check.blocked'
                    | translate: { folder: checkedFolder() }
                "
              />
            </p>
            <p class="text-muted-foreground">
              <mt-rich-text
                [text]="
                  'hardening.check.blockedNext'
                    | translate: { url: checkedUrl() }
                "
              />
            </p>
          }
          @case ('not_gate') {
            <p class="text-destructive">
              {{ 'hardening.check.notGate' | translate }}
            </p>
          }
          @default {
            <p class="text-destructive">
              @if (result.reason; as reason) {
                {{ 'recipe.failed.' + reason | translate }}
              } @else {
                {{ 'hardening.check.incomplete' | translate }}
              }
            </p>
          }
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HardeningCheck {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  /** The project's id. */
  readonly project = input.required<string>();
  /** The gate's name in the project; with the project, the key what was typed is kept under. */
  readonly gate = input.required<string>();

  protected readonly form = new FormGroup({
    url: new FormControl('', { nonNullable: true }),
    dataFolder: new FormControl('', { nonNullable: true }),
  });
  protected readonly busy = signal(false);
  protected readonly notice = signal<HardeningNotice | null>(null);
  protected readonly report = signal<HardeningCheckReport | null>(null);
  protected readonly checkedUrl = signal('');
  protected readonly checkedFolder = signal('');
  private static next = 0;
  protected readonly ids = (() => {
    const n = HardeningCheck.next++;
    return { url: `hardening-url-${n}`, folder: `hardening-folder-${n}` };
  })();

  constructor() {
    effect(() => {
      const remembered = recall(this.key());
      this.form.setValue({ url: remembered?.url ?? '', dataFolder: '' });
      this.report.set(null);
      this.notice.set(null);
    });
  }

  protected async check(): Promise<void> {
    if (this.busy()) return;
    const url = this.form.controls.url.value.trim();
    const dataFolder = this.form.controls.dataFolder.value.trim();
    this.report.set(null);
    this.notice.set(null);
    if (!DATA_FOLDER.test(dataFolder)) {
      this.notice.set('folder_format');
      return;
    }
    remember(this.key(), { url });
    this.busy.set(true);
    try {
      const report = await firstValueFrom(
        this.http.post<HardeningCheckReport>(
          apiUrl(
            `/projects/${encodeURIComponent(this.project())}/hardening-check`,
          ),
          { url, dataFolder, locale: this.translate.getCurrentLang() ?? '' },
        ),
      );
      this.checkedUrl.set(url);
      this.checkedFolder.set(dataFolder);
      this.report.set(report);
    } catch (error) {
      this.notice.set(noticeOf(error));
    } finally {
      this.busy.set(false);
    }
  }

  private key(): string {
    return `${STORAGE_PREFIX}${this.project()}.${this.gate()}`;
  }
}

function noticeOf(error: unknown): HardeningNotice {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  const code = (error.error as { error?: unknown } | null)?.error;
  return HARDENING_REFUSALS.find((known) => known === code) ?? 'failed';
}

function recall(key: string): Remembered | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Remembered).url === 'string'
    )
      return { url: (value as Remembered).url.slice(0, 2048) };
  } catch {
    // Storage blocked or damaged: start empty.
  }
  return null;
}

function remember(key: string, value: Remembered): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: typed again next time.
  }
}
