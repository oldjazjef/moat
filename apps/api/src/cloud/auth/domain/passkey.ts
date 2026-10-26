import { fromBase64Url, isRpId } from '@moat/core';

/** How long a challenge for a passkey ceremony lives. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;
export const CHALLENGE_BYTES = 32;
export const PASSKEY_NAME_MAX = 60;

/**
 * Where passkeys of this installation are valid: the relying party id is the host of
 * `MOAT_PUBLIC_ORIGIN` and the only origin accepted is that origin itself. A browser refuses
 * WebAuthn without a secure context, and an IP address is no relying party id, so those
 * installations have no passkeys (`available: false`) instead of ones that would not work.
 */
export interface RelyingParty {
  readonly available: boolean;
  readonly rpId: string;
  readonly origin: string;
}

export function relyingPartyOf(publicOrigin: string): RelyingParty {
  try {
    const url = new URL(publicOrigin);
    const secure =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && url.hostname === 'localhost');
    const rpId = url.hostname;
    return {
      available: secure && isRpId(rpId),
      rpId,
      origin: url.origin,
    };
  } catch {
    return { available: false, rpId: '', origin: '' };
  }
}

/** Strict base64url (no padding) of a bounded length, or null. */
export function bytesOfBase64Url(
  text: unknown,
  minLength: number,
  maxLength: number,
): Uint8Array | null {
  if (typeof text !== 'string' || text.length > Math.ceil((maxLength * 4) / 3))
    return null;
  try {
    const bytes = fromBase64Url(text);
    return bytes.length >= minLength && bytes.length <= maxLength
      ? bytes
      : null;
  } catch {
    return null;
  }
}

/** The challenge a `clientDataJSON` carries (32 bytes), or null. Nothing else is read from it here. */
export function challengeOfClientData(
  clientData: Uint8Array,
): Uint8Array | null {
  if (clientData.length > 2048) return null;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(clientData),
    );
    if (typeof parsed !== 'object' || parsed === null) return null;
    return bytesOfBase64Url(
      (parsed as { challenge?: unknown }).challenge,
      CHALLENGE_BYTES,
      CHALLENGE_BYTES,
    );
  } catch {
    return null;
  }
}

/** The label of a passkey as the person typed it, trimmed; null when it is empty, long or has control characters. */
export function passkeyName(input: string): string | null {
  const name = input.trim();
  if (name === '' || name.length > PASSKEY_NAME_MAX) return null;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return name;
}
