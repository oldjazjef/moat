import { Injectable } from '@nestjs/common';
import {
  CONFIG_FILE,
  planPull,
  planPush,
  readLocalProject,
  sha256Hex,
  verifyPulledBundle,
  type PlanSigner,
  type SyncIssue,
} from '@moat/core';
import {
  BundleExistsError,
  ProjectFilesPort,
} from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { SyncStatePort } from '../ports/sync-state.port';
import {
  SyncConflictError,
  SyncTargetPort,
  type DatabaseRefusal,
  type SyncSession,
} from '../ports/sync-target.port';
import { PROJECT_ID } from '../project.types';
import { HistoryService } from './history.service';

export type SyncDirection = 'push' | 'pull';

/** The project's name in the database (`sync_project.key`). */
export const DATABASE_KEY = /^[a-z][a-z0-9-]{0,62}$/;

export interface DatabaseSyncInput {
  /** The connection string, from the main process's database window only; never stored here. */
  readonly url: string;
  readonly key: string;
  readonly direction: SyncDirection;
  /** The public half of the person's key: only bundles it signed are copied (both ways). */
  readonly signer: PlanSigner;
}

export type DatabaseSyncResult =
  | {
      readonly status: 'done';
      readonly direction: SyncDirection;
      readonly key: string;
      /** moat.yaml was written (in the database or in the folder). */
      readonly config: boolean;
      readonly gates: number;
      readonly secrets: number;
      readonly bundles: number;
      /** Conflicts and notes: nothing was overwritten for any of them (DT-13). */
      readonly issues: readonly SyncIssue[];
    }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: DatabaseRefusal | 'key_invalid' | 'config_missing';
    }
  /** The database changed while this ran: nothing was written, run it again. */
  | { readonly status: 'changed' }
  /** The project folder could not be written. */
  | { readonly status: 'not_writable' };

/**
 * «Externe Datenbank» (DT-03, DT-13): copies a project folder into a PostgreSQL database
 * (push) or the database's newer files into the folder (pull). Called in-process by the desktop's
 * main process only — the connection string is typed in its window, never in the page.
 */
@Injectable()
export class DatabaseSyncService {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
    private readonly target: SyncTargetPort,
    private readonly state: SyncStatePort,
    private readonly history: HistoryService,
  ) {}

  async sync(
    id: string,
    input: DatabaseSyncInput,
    now = new Date(),
  ): Promise<DatabaseSyncResult> {
    if (!PROJECT_ID.test(id)) return { status: 'not_found' };
    const entry = this.registry.get(id);
    const storage = entry === null ? null : this.files.open(entry.folder);
    if (entry === null || storage === null) return { status: 'not_found' };
    if (!DATABASE_KEY.test(input.key))
      return { status: 'refused', code: 'key_invalid' };
    const local = await readLocalProject(storage, input.signer);
    if (input.direction === 'push' && local.config === null)
      return { status: 'refused', code: 'config_missing' };

    const opened = await this.target.open(input.url);
    if (opened.status === 'refused') return opened;
    const session = opened.session;
    try {
      const remote = await session.read(input.key);
      const base = this.state.base(id, input.key);
      if (input.direction === 'push') {
        const planned = planPush(local, remote, base);
        // Without a moat.yaml in the database (it did not load here) there is no project row to
        // hang the rest on: nothing is written, the issue says why.
        const plan =
          planned.config === null && remote.config === null
            ? { ...planned, gates: [], secrets: [], bundles: [] }
            : planned;
        if (
          plan.config !== null ||
          plan.gates.length + plan.secrets.length + plan.bundles.length > 0
        )
          await session.write(input.key, plan, now.toISOString());
        const agreed =
          plan.config?.hash ??
          (remote.config?.hash === local.config?.hash
            ? remote.config?.hash
            : undefined);
        if (agreed !== undefined) this.state.setBase(id, input.key, agreed);
        return this.done(id, 'push', input.key, now, {
          config: plan.config !== null,
          gates: plan.gates.length,
          secrets: plan.secrets.length,
          bundles: plan.bundles.length,
          issues: plan.issues,
        });
      }
      return await this.pull(
        id,
        entry.folder,
        input,
        local,
        remote,
        base,
        session,
        now,
      );
    } catch (error) {
      if (error instanceof SyncConflictError) return { status: 'changed' };
      throw error;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  private async pull(
    id: string,
    folder: string,
    input: DatabaseSyncInput,
    local: Awaited<ReturnType<typeof readLocalProject>>,
    remote: Awaited<ReturnType<SyncSession['read']>>,
    base: string | null,
    session: SyncSession,
    now: Date,
  ): Promise<DatabaseSyncResult> {
    const plan = planPull(local, remote, base);
    const issues = [...plan.issues];
    let config = false;
    try {
      if (plan.config !== null) {
        // Re-read: an edit that landed meanwhile is never overwritten.
        const current = this.files.open(folder)?.read(CONFIG_FILE) ?? null;
        const currentHash = current === null ? null : await sha256Hex(current);
        if (currentHash !== (local.config?.hash ?? null))
          issues.push({
            code: 'config_conflict',
            gate: null,
            name: null,
            version: null,
          });
        else {
          if (current === null)
            this.files.createConfig(folder, plan.config.text);
          else this.files.writeConfig(folder, plan.config.text);
          config = true;
        }
      }
      for (const secret of plan.secrets)
        this.files.writeSecret(folder, secret.gate, secret.name, secret.text);
      const gateIds = new Map(
        local.gates.map((gate) => [gate.name, gate.gateId]),
      );
      let bundles = 0;
      for (const ref of plan.bundles) {
        const text = await session.bundleText(input.key, ref.gate, ref.version);
        const gateId = gateIds.get(ref.gate);
        if (
          text === null ||
          gateId === undefined ||
          !(await verifyPulledBundle(text, ref, gateId, input.signer))
        ) {
          issues.push({
            code: 'bundle_unverified',
            gate: ref.gate,
            name: null,
            version: ref.version,
          });
          continue;
        }
        try {
          this.files.writeBundle(folder, ref.gate, ref.version, text);
          bundles += 1;
        } catch (error) {
          if (!(error instanceof BundleExistsError)) throw error;
          issues.push({
            code: 'bundle_conflict',
            gate: ref.gate,
            name: null,
            version: ref.version,
          });
        }
      }
      const agreed = config
        ? plan.config?.hash
        : remote.config !== null && remote.config.hash === local.config?.hash
          ? remote.config.hash
          : undefined;
      if (agreed !== undefined) this.state.setBase(id, input.key, agreed);
      return this.done(id, 'pull', input.key, now, {
        config,
        gates: 0,
        secrets: plan.secrets.length,
        bundles,
        issues,
      });
    } catch (error) {
      if (error instanceof SyncConflictError) throw error;
      return { status: 'not_writable' };
    }
  }

  private async done(
    id: string,
    direction: SyncDirection,
    key: string,
    now: Date,
    counts: {
      config: boolean;
      gates: number;
      secrets: number;
      bundles: number;
      issues: readonly SyncIssue[];
    },
  ): Promise<DatabaseSyncResult> {
    await this.history.record(
      id,
      {
        kind: direction === 'push' ? 'database_pushed' : 'database_pulled',
        details: {
          key,
          config: counts.config,
          gates: counts.gates,
          secrets: counts.secrets,
          bundles: counts.bundles,
          conflicts: counts.issues.length,
        },
      },
      now,
    );
    return { status: 'done', direction, key, ...counts };
  }
}
