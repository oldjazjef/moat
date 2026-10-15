import type {
  HistoryAnchor,
  HistoryRow,
  PushPlan,
  RemoteProject,
  SecretFile,
} from '@moat/core';
import {
  HistoryConflictError,
  HistoryStorePort,
} from '../ports/history-store.port';
import { SyncStatePort } from '../ports/sync-state.port';
import {
  SyncConflictError,
  SyncTargetPort,
  type DatabaseRefusal,
  type SyncSession,
} from '../ports/sync-target.port';
import { HistoryService } from '../application/history.service';
import type { ProjectRegistryPort } from '../ports/project-registry.port';

/** The local history in memory, for handler specs. */
export class InMemoryHistoryStore extends HistoryStorePort {
  readonly rows = new Map<string, HistoryRow[]>();
  readonly anchors = new Map<string, HistoryAnchor>();

  enabled(projectId: string): boolean {
    return this.rows.has(projectId);
  }

  enable(projectId: string): Promise<void> {
    if (!this.rows.has(projectId)) this.rows.set(projectId, []);
    return Promise.resolve();
  }

  list(projectId: string): Promise<HistoryRow[]> {
    return Promise.resolve([...(this.rows.get(projectId) ?? [])]);
  }

  anchor(projectId: string): HistoryAnchor | null {
    return this.anchors.get(projectId) ?? null;
  }

  append(projectId: string, row: HistoryRow): Promise<void> {
    const rows = this.rows.get(projectId);
    if (rows === undefined) throw new Error('not enabled');
    if (rows.some((known) => known.seq === row.seq))
      throw new HistoryConflictError('seq');
    rows.push(row);
    this.anchors.set(projectId, { seq: row.seq, hash: row.hash });
    return Promise.resolve();
  }
}

export function historyService(
  registry: ProjectRegistryPort,
  store = new InMemoryHistoryStore(),
): HistoryService {
  return new HistoryService(registry, store);
}

interface StoredProject {
  config: { text: string; hash: string; revision: number } | null;
  gates: Map<string, string>;
  secrets: Map<string, SecretFile>;
  bundles: Map<
    string,
    { gate: string; version: number; digest: string; text: string }
  >;
}

/** A database in memory with the same locks as the PostgreSQL adapter (DT-13). */
export class InMemorySyncTarget extends SyncTargetPort {
  readonly projects = new Map<string, StoredProject>();
  /** Every connection string open() was given (asserted never stored elsewhere). */
  readonly urls: string[] = [];
  refusal: DatabaseRefusal | null = null;
  /** Called between read and write: a second desktop at work. */
  beforeWrite: (() => void) | null = null;

  open(url: string) {
    this.urls.push(url);
    if (this.refusal !== null)
      return Promise.resolve({
        status: 'refused',
        code: this.refusal,
      } as const);
    return Promise.resolve({
      status: 'open',
      session: this.session(),
    } as const);
  }

  project(key: string): StoredProject {
    let project = this.projects.get(key);
    if (project === undefined) {
      project = {
        config: null,
        gates: new Map(),
        secrets: new Map(),
        bundles: new Map(),
      };
      this.projects.set(key, project);
    }
    return project;
  }

  private session(): SyncSession {
    return {
      read: (key) => {
        const project = this.projects.get(key);
        const remote: RemoteProject =
          project === undefined
            ? { config: null, gates: [], secrets: [], bundles: [] }
            : {
                config: project.config,
                gates: [...project.gates].map(([name, text]) => ({
                  name,
                  text,
                })),
                secrets: [...project.secrets.values()],
                bundles: [...project.bundles.values()].map(
                  ({ gate, version, digest }) => ({ gate, version, digest }),
                ),
              };
        return Promise.resolve(structuredClone(remote));
      },
      bundleText: (key, gate, version) =>
        Promise.resolve(
          this.projects.get(key)?.bundles.get(`${gate}/${version}`)?.text ??
            null,
        ),
      write: (key, plan: PushPlan) => {
        this.beforeWrite?.();
        const copy = structuredClone(this.projects.get(key) ?? null);
        try {
          this.apply(key, plan);
        } catch (error) {
          if (copy === null) this.projects.delete(key);
          else this.projects.set(key, copy);
          throw error;
        }
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
  }

  private apply(key: string, plan: PushPlan): void {
    const existing = this.projects.get(key);
    if (plan.config === null) {
      if (existing?.config == null) throw new SyncConflictError('project');
    } else if (plan.config.expectedRevision === null) {
      if (existing?.config != null) throw new SyncConflictError('config');
    } else if (existing?.config?.revision !== plan.config.expectedRevision)
      throw new SyncConflictError('config');
    const project = this.project(key);
    if (plan.config !== null)
      project.config = {
        text: plan.config.text,
        hash: plan.config.hash,
        revision: (plan.config.expectedRevision ?? 0) + 1,
      };
    for (const gate of plan.gates) {
      if (project.gates.has(gate.name)) throw new SyncConflictError('gate');
      project.gates.set(gate.name, gate.text);
    }
    for (const secret of plan.secrets) {
      const id = `${secret.gate}/${secret.name}`;
      const there = project.secrets.get(id);
      if ((there?.secretVersion ?? null) !== secret.expectedVersion)
        throw new SyncConflictError('secret');
      project.secrets.set(id, {
        gate: secret.gate,
        name: secret.name,
        secretVersion: secret.secretVersion,
        text: secret.text,
      });
    }
    for (const bundle of plan.bundles) {
      const id = `${bundle.gate}/${bundle.version}`;
      if (project.bundles.has(id)) throw new SyncConflictError('bundle');
      project.bundles.set(id, { ...bundle });
    }
  }
}

export class InMemorySyncState extends SyncStatePort {
  readonly bases = new Map<string, string>();

  base(projectId: string, key: string): string | null {
    return this.bases.get(`${projectId}/${key}`) ?? null;
  }

  setBase(projectId: string, key: string, configHash: string): void {
    this.bases.set(`${projectId}/${key}`, configHash);
  }
}
