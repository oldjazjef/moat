import { Injectable } from '@nestjs/common';
import type { GateMode, GateRecord } from '../../cloud/gates/ports/gates.ports';
import {
  CloudTrafficStorePort,
  type TrafficRecord,
} from '../../cloud/traffic/ports/traffic.ports';
import { CloudDatabase } from './cloud-database';

/** `errors` was written by this adapter from a checked report; anything else reads as none. */
function errorsOf(text: string): Record<string, number> {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    );
  } catch {
    return {};
  }
}

@Injectable()
export class PrismaCloudTrafficStore extends CloudTrafficStorePort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async setReportTokenHash(
    projectId: string,
    gate: string,
    hash: string,
    at: string,
  ): Promise<boolean> {
    const found = await this.db.cloudGate.count({
      where: { projectId, name: gate },
    });
    if (found !== 1) return false;
    await this.db.cloudReportAddress.upsert({
      where: { projectId_gate: { projectId, gate } },
      create: { projectId, gate, tokenHash: hash, createdAt: at },
      update: { tokenHash: hash, createdAt: at },
    });
    return true;
  }

  async gatesWithReportAddress(projectId: string): Promise<readonly string[]> {
    const rows = await this.db.cloudReportAddress.findMany({
      where: { projectId },
      select: { gate: true },
      orderBy: { gate: 'asc' },
    });
    return rows.map((row) => row.gate);
  }

  async findGateByReportTokenHash(hash: string): Promise<GateRecord | null> {
    const row = await this.db.cloudReportAddress.findUnique({
      where: { tokenHash: hash },
      include: { gateRef: true },
    });
    return row === null
      ? null
      : { ...row.gateRef, mode: row.gateRef.mode as GateMode };
  }

  async record(
    projectId: string,
    gate: string,
    buckets: readonly Omit<TrafficRecord, 'gate'>[],
    olderThanHour: number,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      for (const bucket of buckets) {
        const data = {
          requests: bucket.requests,
          s2: bucket.s2,
          s3: bucket.s3,
          s4: bucket.s4,
          s5: bucket.s5,
          errors: JSON.stringify(bucket.errors),
          msTotal: BigInt(bucket.msTotal),
          msMax: bucket.msMax,
          receivedAt: bucket.receivedAt,
        };
        const key = {
          projectId,
          gate,
          hour: BigInt(bucket.hour),
          route: bucket.route ?? '',
        };
        await tx.cloudTraffic.upsert({
          where: { projectId_gate_hour_route: key },
          create: { ...key, ...data },
          update: data,
        });
      }
      await tx.cloudTraffic.deleteMany({
        where: { projectId, gate, hour: { lt: BigInt(olderThanHour) } },
      });
    });
  }

  async traffic(
    projectId: string,
    fromHour: number,
  ): Promise<readonly TrafficRecord[]> {
    const rows = await this.db.cloudTraffic.findMany({
      where: { projectId, hour: { gte: BigInt(fromHour) } },
      orderBy: [{ hour: 'asc' }, { gate: 'asc' }, { route: 'asc' }],
    });
    return rows.map((row) => ({
      gate: row.gate,
      hour: Number(row.hour),
      route: row.route === '' ? null : row.route,
      requests: row.requests,
      s2: row.s2,
      s3: row.s3,
      s4: row.s4,
      s5: row.s5,
      errors: errorsOf(row.errors),
      msTotal: Number(row.msTotal),
      msMax: row.msMax,
      receivedAt: row.receivedAt,
    }));
  }
}
