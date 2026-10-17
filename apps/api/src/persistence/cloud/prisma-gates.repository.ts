import { Injectable } from '@nestjs/common';
import {
  type AddBundleOutcome,
  type AddGateOutcome,
  type BundleRecord,
  CloudProjectStorePort,
  type ConfigRecord,
  type GateMode,
  type GateRecord,
  MAX_GATES,
  MAX_SECRETS,
  type PutSecretOutcome,
  type SecretRecord,
  type SetConfigOutcome,
} from '../../cloud/gates/ports/gates.ports';
import { CloudDatabase } from './cloud-database';

const code = (error: unknown): unknown => (error as { code?: unknown }).code;

/** The database's CHECK keeps `mode` to the two known values. */
function gateOf(row: {
  projectId: string;
  name: string;
  gateId: string;
  boxKey: string;
  mode: string;
  signerKid: string | null;
  signerKey: string | null;
  pullTokenHash: string | null;
  createdAt: string;
}): GateRecord {
  return { ...row, mode: row.mode as GateMode };
}

@Injectable()
export class PrismaCloudProjectStore extends CloudProjectStorePort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  getConfig(projectId: string): Promise<ConfigRecord | null> {
    return this.db.cloudConfig.findUnique({ where: { projectId } });
  }

  async setConfig(
    projectId: string,
    text: string,
    expectedRevision: number,
    at: string,
  ): Promise<SetConfigOutcome> {
    if (expectedRevision === 0) {
      try {
        await this.db.cloudConfig.create({
          data: { projectId, text, revision: 1, updatedAt: at },
        });
        return 'ok';
      } catch (error) {
        if (code(error) === 'P2002') return 'conflict';
        throw error;
      }
    }
    // The revision in the WHERE is the compare-and-set: a racing writer changes it first.
    const updated = await this.db.cloudConfig.updateMany({
      where: { projectId, revision: expectedRevision },
      data: { text, revision: expectedRevision + 1, updatedAt: at },
    });
    return updated.count === 1 ? 'ok' : 'conflict';
  }

  async listGates(projectId: string): Promise<readonly GateRecord[]> {
    const rows = await this.db.cloudGate.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
    });
    return rows.map(gateOf);
  }

  async findGate(projectId: string, name: string): Promise<GateRecord | null> {
    const row = await this.db.cloudGate.findUnique({
      where: { projectId_name: { projectId, name } },
    });
    return row === null ? null : gateOf(row);
  }

  async addGate(gate: GateRecord): Promise<AddGateOutcome> {
    try {
      return await this.db.$transaction(async (tx) => {
        const count = await tx.cloudGate.count({
          where: { projectId: gate.projectId },
        });
        if (count >= MAX_GATES) return 'limit';
        await tx.cloudGate.create({ data: { ...gate } });
        return 'ok';
      });
    } catch (error) {
      if (code(error) === 'P2002') return 'exists';
      throw error;
    }
  }

  async setPullTokenHash(
    projectId: string,
    name: string,
    hash: string,
  ): Promise<boolean> {
    const updated = await this.db.cloudGate.updateMany({
      where: { projectId, name },
      data: { pullTokenHash: hash },
    });
    return updated.count === 1;
  }

  async findGateByPullTokenHash(hash: string): Promise<GateRecord | null> {
    const row = await this.db.cloudGate.findUnique({
      where: { pullTokenHash: hash },
    });
    return row === null ? null : gateOf(row);
  }

  listSecrets(
    projectId: string,
    gate: string,
  ): Promise<readonly SecretRecord[]> {
    return this.db.cloudSecret.findMany({
      where: { projectId, gate },
      orderBy: { name: 'asc' },
    });
  }

  async putSecret(secret: SecretRecord): Promise<PutSecretOutcome> {
    const key = {
      projectId: secret.projectId,
      gate: secret.gate,
      name: secret.name,
    };
    // A higher version replaces the stored one in one statement (no read-then-write race).
    const replaced = await this.db.cloudSecret.updateMany({
      where: { ...key, secretVersion: { lt: secret.secretVersion } },
      data: {
        secretVersion: secret.secretVersion,
        text: secret.text,
        updatedAt: secret.updatedAt,
      },
    });
    if (replaced.count === 1) return 'ok';
    const existing = await this.db.cloudSecret.findUnique({
      where: { projectId_gate_name: key },
      select: { secretVersion: true },
    });
    if (existing !== null) return 'stale';
    const count = await this.db.cloudSecret.count({
      where: { projectId: secret.projectId, gate: secret.gate },
    });
    if (count >= MAX_SECRETS) return 'limit';
    try {
      await this.db.cloudSecret.create({ data: { ...secret } });
      return 'ok';
    } catch (error) {
      if (code(error) === 'P2002') return 'stale';
      if (code(error) === 'P2003') return 'no_gate';
      throw error;
    }
  }

  latestBundle(projectId: string, gate: string): Promise<BundleRecord | null> {
    return this.db.cloudBundle.findFirst({
      where: { projectId, gate },
      orderBy: { version: 'desc' },
    });
  }

  async addBundle(bundle: BundleRecord): Promise<AddBundleOutcome> {
    try {
      await this.db.cloudBundle.create({ data: { ...bundle } });
      return 'ok';
    } catch (error) {
      if (code(error) === 'P2002') return 'exists';
      throw error;
    }
  }
}
