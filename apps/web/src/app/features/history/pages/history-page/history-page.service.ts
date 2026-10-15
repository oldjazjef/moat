import { HttpClient, httpResource } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import type {
  HistoryCheck,
  HistoryEntryView,
  HistoryView,
} from '../../../../core/api/history.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import {
  desktopBridge,
  type DatabaseResult,
} from '../../../../core/desktop/desktop-bridge';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/** `history.notices.<notice>`. */
export type HistoryNotice = 'failed';

/** One row as the page shows it: newest first, digests shortened. */
export interface HistoryRowView {
  readonly seq: number;
  readonly at: string;
  readonly kind: HistoryEntryView['kind'];
  /** Parameters of `history.kinds.<kind>`. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
  /** `history.targets.<target>` for a deploy, else null. */
  readonly target: string | null;
  readonly hash: string;
}

const short = (value: unknown) =>
  typeof value === 'string' ? value.slice(0, 12) : '';

/**
 * «Verlauf» (DT-03): what Moat Desktop did in this project — bundles signed, secrets sealed,
 * deploys, edits of moat.yaml, database copies — once the person switched it on. «Prüfen» checks
 * the hash chain in the API. In the desktop the page also opens the database window, where the
 * connection string is typed (never here).
 */
@Injectable()
export class HistoryPageService {
  readonly resource = inject(ProjectResource);
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly bridge = desktopBridge();

  readonly view = httpResource<HistoryView>(() =>
    this.resource.id() === ''
      ? undefined
      : apiUrl(`/projects/${encodeURIComponent(this.resource.id())}/history`),
  );

  readonly busy = signal(false);
  readonly notice = signal<HistoryNotice | null>(null);
  readonly check = signal<HistoryCheck | null>(null);
  readonly database = signal<DatabaseResult | null>(null);
  /** Only Moat Desktop has the database window. */
  readonly canUseDatabase = this.bridge?.database !== undefined;

  readonly enabled = computed(() =>
    this.view.hasValue() ? this.view.value().enabled : null,
  );

  readonly rows = computed<readonly HistoryRowView[]>(() =>
    this.view.hasValue()
      ? [...this.view.value().entries].reverse().map((entry) => ({
          seq: entry.seq,
          at: entry.at,
          kind: entry.kind,
          params: {
            ...entry.details,
            sha256: short(entry.details['sha256']),
            before: short(entry.details['before']),
            after: short(entry.details['after']),
          },
          target:
            entry.kind === 'deploy' &&
            typeof entry.details['target'] === 'string'
              ? entry.details['target']
              : null,
          hash: short(entry.hash),
        }))
      : [],
  );

  async enable(): Promise<void> {
    await this.work(async () => {
      await firstValueFrom(
        this.http.post<HistoryView>(this.url('/history'), {}),
      );
      this.view.reload();
    });
  }

  async verify(): Promise<void> {
    this.check.set(null);
    await this.work(async () => {
      this.check.set(
        await firstValueFrom(
          this.http.post<HistoryCheck>(this.url('/history/verify'), {}),
        ),
      );
    });
  }

  /** Opens the database window; afterwards the folder and the history are read again. */
  async openDatabase(): Promise<void> {
    const database = this.bridge?.database;
    if (database === undefined) return;
    this.database.set(null);
    await this.work(async () => {
      const result = await database.open(
        this.resource.id(),
        this.translate.getCurrentLang() ?? '',
      );
      if (result.status === 'cancelled') return;
      this.database.set(result);
      this.resource.reload();
      this.view.reload();
    });
  }

  private url(path: string): string {
    return apiUrl(`/projects/${encodeURIComponent(this.resource.id())}${path}`);
  }

  private async work(task: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      await task();
    } catch {
      this.notice.set('failed');
    } finally {
      this.busy.set(false);
    }
  }
}
