import { Injectable, Logger } from '@nestjs/common';
import {
  chainHistory,
  verifyHistory,
  type HistoryCheck,
  type HistoryEvent,
  type HistoryKind,
} from '@moat/core';
import { HistoryStorePort } from '../ports/history-store.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';

/** One row as the «Verlauf» page shows it: the details as data, never a secret or a path. */
export interface HistoryEntryView {
  readonly seq: number;
  readonly at: string;
  readonly kind: HistoryKind;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly hash: string;
}

export interface HistoryView {
  readonly enabled: boolean;
  /** Oldest first. */
  readonly entries: readonly HistoryEntryView[];
}

/**
 * The project's history (DT-03, «Verlauf»): what Moat Desktop did, recorded only after the person
 * switched it on, append-only and hash-chained (core history.ts). Recording never stops the
 * action it records — the bundle is signed, the secret sealed — and a failure is logged without
 * values; «Prüfen» then shows the gap.
 */
@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);
  /** One write after the other per project: each row needs the one before. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly store: HistoryStorePort,
  ) {}

  async view(id: string): Promise<HistoryView | null> {
    if (!this.known(id)) return null;
    if (!this.store.enabled(id)) return { enabled: false, entries: [] };
    await this.queues.get(id);
    const rows = await this.store.list(id);
    return {
      enabled: true,
      entries: rows.map((row) => ({
        seq: row.seq,
        at: row.at,
        kind: row.kind,
        details: parseDetails(row.details),
        hash: row.hash,
      })),
    };
  }

  /** Switches the history on (once; the first row says when). */
  async enable(id: string, now = new Date()): Promise<HistoryView | null> {
    if (!this.known(id)) return null;
    if (!this.store.enabled(id)) {
      await this.store.enable(id);
      await this.record(id, { kind: 'history_started', details: {} }, now);
    }
    return this.view(id);
  }

  async verify(id: string): Promise<HistoryCheck | null> {
    if (!this.known(id)) return null;
    await this.queues.get(id);
    if (!this.store.enabled(id)) return { status: 'intact', entries: 0 };
    return verifyHistory(await this.store.list(id), this.store.anchor(id));
  }

  /** Appends the event when the project has a history; never throws. */
  record(id: string, event: HistoryEvent, now = new Date()): Promise<void> {
    if (!PROJECT_ID.test(id) || !this.store.enabled(id))
      return Promise.resolve();
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const last = (await this.store.list(id)).at(-1) ?? null;
        const row = await chainHistory(
          last === null ? null : { seq: last.seq, hash: last.hash },
          now.toISOString(),
          event,
        );
        await this.store.append(id, row);
      } catch {
        this.logger.warn(`history: a ${event.kind} entry was not recorded`);
      }
    });
    this.queues.set(id, next);
    return next;
  }

  private known(id: string): boolean {
    return PROJECT_ID.test(id) && this.registry.get(id) !== null;
  }
}

function parseDetails(
  text: string,
): Readonly<Record<string, string | number | boolean>> {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string | number | boolean] =>
          ['string', 'number', 'boolean'].includes(typeof entry[1]),
      ),
    );
  } catch {
    return {};
  }
}
