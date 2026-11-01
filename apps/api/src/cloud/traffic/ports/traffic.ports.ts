import type { GateRecord } from '../../gates/ports/gates.ports';

/** One reported (gate, route, hour): sums only. `route` null = requests that matched no route. */
export interface TrafficRecord {
  readonly gate: string;
  /** Unix seconds of the hour's start. */
  readonly hour: number;
  readonly route: string | null;
  readonly requests: number;
  readonly s2: number;
  readonly s3: number;
  readonly s4: number;
  readonly s5: number;
  readonly errors: Readonly<Record<string, number>>;
  readonly msTotal: number;
  readonly msMax: number;
  /** When Moat Cloud received it (ISO 8601). */
  readonly receivedAt: string;
}

/** How long reported traffic is kept (and the oldest hour a report may hold). */
export const TRAFFIC_RETENTION_HOURS = 24 * 30;

/**
 * Reported traffic and the report addresses (FR-50, FR-51, T-110). The report address belongs to
 * one gate: only its token's SHA-256 is kept. Every write replaces the reported (hour, route)
 * buckets of that gate — a report sent twice counts once.
 */
export abstract class CloudTrafficStorePort {
  /** Replaces the gate's report address; false when there is no such gate. */
  abstract setReportTokenHash(
    projectId: string,
    gate: string,
    hash: string,
    at: string,
  ): Promise<boolean>;
  /** The gates of the project that have a report address. */
  abstract gatesWithReportAddress(
    projectId: string,
  ): Promise<readonly string[]>;
  /** The gate whose report address holds the token with this hash. */
  abstract findGateByReportTokenHash(hash: string): Promise<GateRecord | null>;
  /**
   * Writes the buckets of one report (each replacing the same gate, hour and route) and drops
   * this gate's buckets older than `olderThanHour`, in one transaction.
   */
  abstract record(
    projectId: string,
    gate: string,
    buckets: readonly Omit<TrafficRecord, 'gate'>[],
    olderThanHour: number,
  ): Promise<void>;
  /** The project's traffic from `fromHour` on, oldest first. */
  abstract traffic(
    projectId: string,
    fromHour: number,
  ): Promise<readonly TrafficRecord[]>;
}
