import { Injectable } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PushPlan, RemoteProject } from '@moat/core';
import { Client } from 'pg';
import { PrismaClient } from '../../generated/prisma-postgresql/client';
import {
  SyncConflictError,
  SyncTargetPort,
  type SyncSession,
} from '../../project/ports/sync-target.port';
import { parseDatabaseUrl } from './database-url';
import { postgresMigrationConnection } from './migration-connections';
import { MIGRATIONS } from './migrations';
import { migrate, SchemaRefusedError } from './migrator';

/**
 * An external PostgreSQL database as sync and backup target (DT-03, DT-13), through Prisma 7 and
 * `@prisma/adapter-pg` (pure JS, `pg`). Before Prisma touches it, one plain connection checks the
 * schema and applies the migrations (migrator.ts) or refuses. Every write is one transaction whose
 * conditions are the optimistic locks: a revision, a secret version, a primary key.
 *
 * Holds ciphertext and signed bundles only: the rows come from core's readLocalProject, which
 * reads nothing else, and the CHECK constraints refuse any other shape (SEC-31).
 */
@Injectable()
export class PostgresSyncTarget extends SyncTargetPort {
  async open(url: string) {
    const parsed = parseDatabaseUrl(url);
    if (parsed.status === 'refused') return parsed;
    const client = new Client(parsed.config);
    try {
      await client.connect();
    } catch {
      // Never the driver's message: it can carry the host's answer (SEC-34).
      await client.end().catch(() => undefined);
      return { status: 'refused', code: 'connect_failed' } as const;
    }
    try {
      await migrate(postgresMigrationConnection(client), MIGRATIONS.postgresql);
    } catch (error) {
      if (error instanceof SchemaRefusedError)
        return { status: 'refused', code: error.code } as const;
      return { status: 'refused', code: 'connect_failed' } as const;
    } finally {
      await client.end().catch(() => undefined);
    }
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ ...parsed.config, max: 2 }),
    });
    return {
      status: 'open',
      session: new PostgresSyncSession(prisma),
    } as const;
  }
}

type Prisma = InstanceType<typeof PrismaClient>;
type Tx = Parameters<Parameters<Prisma['$transaction']>[0]>[0];

class PostgresSyncSession implements SyncSession {
  constructor(private readonly prisma: Prisma) {}

  async read(key: string): Promise<RemoteProject> {
    const project = await this.prisma.syncProject.findUnique({
      where: { key },
      include: {
        gates: { orderBy: { name: 'asc' } },
        secrets: { orderBy: [{ gate: 'asc' }, { name: 'asc' }] },
        bundles: {
          select: { gate: true, version: true, digest: true },
          orderBy: [{ gate: 'asc' }, { version: 'asc' }],
        },
      },
    });
    if (project === null)
      return { config: null, gates: [], secrets: [], bundles: [] };
    return {
      config: {
        text: project.configText,
        hash: project.configHash,
        revision: project.revision,
      },
      gates: project.gates.map(({ name, text }) => ({ name, text })),
      secrets: project.secrets.map(({ gate, name, secretVersion, text }) => ({
        gate,
        name,
        secretVersion,
        text,
      })),
      bundles: project.bundles,
    };
  }

  async bundleText(
    key: string,
    gate: string,
    version: number,
  ): Promise<string | null> {
    const row = await this.prisma.syncBundle.findUnique({
      where: { project_gate_version: { project: key, gate, version } },
      select: { text: true },
    });
    return row?.text ?? null;
  }

  async write(key: string, plan: PushPlan, at: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await writeConfig(tx, key, plan, at);
        for (const gate of plan.gates)
          await tx.syncGate.create({
            data: { project: key, name: gate.name, text: gate.text },
          });
        for (const secret of plan.secrets) {
          if (secret.expectedVersion === null) {
            await tx.syncSecret.create({
              data: {
                project: key,
                gate: secret.gate,
                name: secret.name,
                secretVersion: secret.secretVersion,
                text: secret.text,
              },
            });
            continue;
          }
          const updated = await tx.syncSecret.updateMany({
            where: {
              project: key,
              gate: secret.gate,
              name: secret.name,
              secretVersion: secret.expectedVersion,
            },
            data: { secretVersion: secret.secretVersion, text: secret.text },
          });
          if (updated.count !== 1) throw new SyncConflictError('secret');
        }
        for (const bundle of plan.bundles)
          await tx.syncBundle.create({
            data: {
              project: key,
              gate: bundle.gate,
              version: bundle.version,
              digest: bundle.digest,
              text: bundle.text,
            },
          });
      });
    } catch (error) {
      // A row there already (P2002) is the lock of DT-13 at work.
      if (
        error instanceof SyncConflictError ||
        (error as { code?: unknown }).code === 'P2002'
      )
        throw new SyncConflictError('changed');
      throw error;
    }
  }

  close(): Promise<void> {
    return this.prisma.$disconnect();
  }
}

async function writeConfig(
  tx: Tx,
  key: string,
  plan: PushPlan,
  at: string,
): Promise<void> {
  const config = plan.config;
  if (config === null) {
    // Gates, secrets and bundles belong to a project row; a push always brings its moat.yaml first.
    if ((await tx.syncProject.count({ where: { key } })) !== 1)
      throw new SyncConflictError('project');
    return;
  }
  if (config.expectedRevision === null) {
    await tx.syncProject.create({
      data: {
        key,
        configText: config.text,
        configHash: config.hash,
        revision: 1,
        updatedAt: at,
      },
    });
    return;
  }
  const updated = await tx.syncProject.updateMany({
    where: { key, revision: config.expectedRevision },
    data: {
      configText: config.text,
      configHash: config.hash,
      revision: config.expectedRevision + 1,
      updatedAt: at,
    },
  });
  if (updated.count !== 1) throw new SyncConflictError('config');
}
