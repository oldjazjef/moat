import type {
  PasskeyAssertionOutcome,
  PasskeyCreateRequest,
  PasskeyEnrollOutcome,
  PasskeyFailure,
  PasskeyGetRequest,
} from '../shared/passkey-dialog';

/**
 * The two WebAuthn calls of the passkey windows (trust mode 2), in the window's preload and
 * nowhere else. Electron shows no passkey prompt of its own: what happens here is whatever the
 * system offers to Chromium (a platform authenticator), or nothing — then the answer is
 * `unavailable` and the window says so. The values go to the main process, which checks them.
 */

export function toBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Whether the system has a passkey (a user-verifying platform authenticator) for Chromium. */
export async function passkeyAvailable(): Promise<boolean> {
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function failureOf(error: unknown): PasskeyFailure {
  const name = error instanceof DOMException ? error.name : '';
  // NotAllowedError: the person said no, or the time ran out.
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  if (name === 'NotSupportedError') return 'unavailable';
  return 'failed';
}

export async function createPasskey(
  request: PasskeyCreateRequest,
): Promise<PasskeyEnrollOutcome> {
  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: toBytes(request.challenge),
        rp: { id: request.rpId, name: request.rpName },
        user: {
          id: toBytes(request.userId),
          name: request.userName,
          displayName: request.rpName,
        },
        // ES256 only: the gate verifies nothing else (docs/CRYPTO.md §7).
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
        attestation: 'none',
        timeout: request.timeoutMs,
      },
    });
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAttestationResponse)
    )
      return { status: 'failed', reason: 'failed' };
    return {
      status: 'created',
      attestationObject: toBase64Url(credential.response.attestationObject),
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
    };
  } catch (error) {
    return { status: 'failed', reason: failureOf(error) };
  }
}

export async function getAssertion(
  request: PasskeyGetRequest,
): Promise<PasskeyAssertionOutcome> {
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: toBytes(request.challenge),
        rpId: request.rpId,
        allowCredentials: [
          { type: 'public-key', id: toBytes(request.credentialId) },
        ],
        userVerification: 'required',
        timeout: request.timeoutMs,
      },
    });
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAssertionResponse)
    )
      return { status: 'failed', reason: 'failed' };
    return {
      status: 'asserted',
      credentialId: toBase64Url(credential.rawId),
      authenticatorData: toBase64Url(credential.response.authenticatorData),
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      signature: toBase64Url(credential.response.signature),
    };
  } catch (error) {
    return { status: 'failed', reason: failureOf(error) };
  }
}
