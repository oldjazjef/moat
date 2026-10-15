import type { DatabaseResult } from '../../shared/bridge';
import {
  DATABASE_ISSUES,
  type DatabaseDialogInput,
  type DatabaseDialogTexts,
  type DatabaseDialogView,
  type DatabaseIssue,
  type DatabaseNotice,
  type DatabaseSummary,
} from '../../shared/database-dialog';
import type { PlanSigner } from './signing';

/** The project's name in the database (core NAME_PATTERN). */
export const DATABASE_KEY = /^[a-z][a-z0-9-]{0,62}$/;
export const MAX_URL_LENGTH = 2048;

/**
 * A project's database connection as `config.json` keeps it (DT-03): the name in the database,
 * what the window may show, and the connection string only as keychain ciphertext (DT-04) — or
 * nothing, when the person did not ask to remember it or there is no real keychain.
 */
export interface DatabaseTarget {
  readonly key: string;
  readonly label: string;
  /** base64 safeStorage ciphertext of the connection string; null: typed each time. */
  readonly url: string | null;
}

/** What the API answers (apps/api DatabaseSyncResult), as far as the window needs it. */
export type SyncAnswer =
  | ({ status: 'done' } & DatabaseSummary)
  | { status: 'not_found' }
  | { status: 'refused'; code: string }
  | { status: 'changed' }
  | { status: 'not_writable' };

export interface DatabaseSessionDeps {
  readonly texts: DatabaseDialogTexts;
  readonly project: string;
  /** The key offered when none is remembered (the folder's name, made a valid key). */
  readonly defaultKey: string;
  readonly keychain: {
    readonly available: boolean;
    seal(secret: string): string;
    open(sealed: string): string | null;
  };
  stored(): DatabaseTarget | null;
  save(target: DatabaseTarget): void;
  forget(): void;
  /** The API's check of a connection string, before anything connects. */
  label(
    url: string,
  ):
    | { status: 'ok'; label: string }
    | { status: 'refused'; code: 'url_invalid' | 'tls_required' };
  /** The public half of the desktop's signing key; null when none is chosen. */
  signer(): PlanSigner | null;
  sync(
    url: string,
    key: string,
    direction: 'push' | 'pull',
    signer: PlanSigner,
  ): Promise<SyncAnswer>;
}

const REFUSALS = new Set<string>([
  'url_invalid',
  'tls_required',
  'connect_failed',
  'foreign_tables',
  'schema_newer',
  'schema_damaged',
  'key_invalid',
  'config_missing',
]);

/**
 * The database window's state (pure, unit-tested): which connection, what the last run did. The
 * connection string lives only in local variables here and in the keychain ciphertext; it never
 * goes into a view, a notice or a log.
 */
export class DatabaseSession {
  private notice: DatabaseNotice | null = null;
  private result: DatabaseSummary | null = null;

  constructor(private readonly deps: DatabaseSessionDeps) {}

  view(): DatabaseDialogView {
    const stored = this.deps.stored();
    return {
      texts: this.deps.texts,
      project: this.deps.project,
      target: {
        label: stored?.label ?? null,
        key: stored?.key ?? this.deps.defaultKey,
        urlRemembered: stored?.url != null,
      },
      canRemember: this.deps.keychain.available,
      notice: this.notice,
      result: this.result,
    };
  }

  async run(input: DatabaseDialogInput): Promise<DatabaseDialogView> {
    this.notice = null;
    this.result = null;
    const key = input.key.trim();
    if (!DATABASE_KEY.test(key)) return this.show('key_invalid');
    const stored = this.deps.stored();
    const typed = input.url.trim();
    let url: string | null = typed;
    if (typed === '')
      url = stored?.url == null ? null : this.deps.keychain.open(stored.url);
    if (url === null || url === '') return this.show('url_missing');
    if (url.length > MAX_URL_LENGTH) return this.show('url_invalid');
    const checked = this.deps.label(url);
    if (checked.status === 'refused') return this.show(checked.code);
    const signer = this.deps.signer();
    if (signer === null) return this.show('key_missing');

    const answer = await this.deps.sync(url, key, input.direction, signer);
    if (answer.status !== 'done') {
      if (answer.status === 'refused')
        return this.show(
          REFUSALS.has(answer.code)
            ? (answer.code as DatabaseNotice)
            : 'failed',
        );
      return this.show(
        answer.status === 'changed'
          ? 'changed'
          : answer.status === 'not_writable'
            ? 'not_writable'
            : 'failed',
      );
    }
    // Remembered only after it worked, and only as keychain ciphertext.
    const remember = input.remember && this.deps.keychain.available;
    this.deps.save({
      key,
      label: checked.label,
      url:
        typed === ''
          ? (stored?.url ?? null)
          : remember
            ? this.deps.keychain.seal(typed)
            : null,
    });
    this.result = {
      direction: answer.direction,
      key: answer.key,
      config: answer.config,
      gates: answer.gates,
      secrets: answer.secrets,
      bundles: answer.bundles,
      issues: answer.issues.filter(isKnownIssue).slice(0, 200),
    };
    return this.view();
  }

  forget(): DatabaseDialogView {
    this.deps.forget();
    return this.show('forgotten');
  }

  /** What the page learns: counts only. */
  outcome(): DatabaseResult {
    const result = this.result;
    if (result === null) return { status: 'cancelled' };
    return {
      status: 'done',
      direction: result.direction,
      config: result.config,
      gates: result.gates,
      secrets: result.secrets,
      bundles: result.bundles,
      issues: result.issues.length,
    };
  }

  private show(notice: DatabaseNotice): DatabaseDialogView {
    this.notice = notice;
    return this.view();
  }
}

function isKnownIssue(issue: DatabaseIssue): boolean {
  return (DATABASE_ISSUES as readonly string[]).includes(issue.code);
}

/** A folder's name as a database key: lower case, `-` for the rest, a letter first. */
export function defaultDatabaseKey(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return DATABASE_KEY.test(slug) ? slug : 'moat';
}
