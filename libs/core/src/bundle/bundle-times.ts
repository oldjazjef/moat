import { fromBase64Url } from '../encoding/base64url';
import { MAX_ENVELOPE_BYTES } from './bundle';

/** When a stored bundle was issued and when it stops being valid (Unix seconds), as it says so itself. */
export interface BundleTimes {
  readonly version: number;
  readonly issuedAt: number;
  /** Null: the bundle does not expire. A gate honours it only when its local policy asks for expiry (SEC-05). */
  readonly expiresAt: number | null;
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Reads version, issue and expiry time of an envelope **without verifying it**: for display and
 * status of a bundle Moat Cloud itself verified before it stored it. Never use it to decide
 * whether a bundle may be trusted. Anything that does not look like an envelope answers `null`.
 */
export function readBundleTimes(envelope: string): BundleTimes | null {
  if (envelope.length > MAX_ENVELOPE_BYTES) return null;
  try {
    const outer: unknown = JSON.parse(envelope);
    if (outer === null || typeof outer !== 'object') return null;
    const encoded = (outer as { payload?: unknown }).payload;
    if (typeof encoded !== 'string') return null;
    const payload: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(encoded)),
    );
    if (payload === null || typeof payload !== 'object') return null;
    const { version, issuedAt, expiresAt } = payload as Record<string, unknown>;
    if (!isTime(version) || version < 1 || !isTime(issuedAt)) return null;
    if (expiresAt !== null && !isTime(expiresAt)) return null;
    return { version, issuedAt, expiresAt };
  } catch {
    return null;
  }
}
