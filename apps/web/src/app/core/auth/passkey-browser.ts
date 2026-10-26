import { Injectable } from '@angular/core';

/** base64url without padding, as the API sends and expects it. */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** What went wrong at the browser, not at Moat Cloud: nothing the API said. */
export type PasskeyProblem = 'unsupported' | 'cancelled' | 'failed';

export class PasskeyBrowserError extends Error {
  override readonly name = 'PasskeyBrowserError';
  constructor(readonly problem: PasskeyProblem) {
    super(problem);
  }
}

/** The parameters of `navigator.credentials.create`, as `POST /auth/passkeys/options` answers. */
export interface PasskeyCreateOptions {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
  };
  readonly excludeCredentials: readonly string[];
  readonly timeoutMs: number;
}

/** The parameters of `navigator.credentials.get`, as `POST /auth/passkey/challenge` answers. */
export interface PasskeyGetOptions {
  readonly challenge: string;
  readonly rpId: string;
  readonly credentialIds: readonly string[];
  readonly timeoutMs: number;
}

export interface CreatedPasskey {
  readonly attestationObject: string;
  readonly clientDataJSON: string;
}

export interface UsedPasskey {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/**
 * WebAuthn in the browser (the only place that touches `navigator.credentials`). Only ES256 and
 * user verification are asked for, and no attestation: Moat stores the public key, nothing else.
 * Specs replace this class.
 */
@Injectable({ providedIn: 'root' })
export class PasskeyBrowser {
  get supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.credentials?.create === 'function' &&
      typeof PublicKeyCredential !== 'undefined'
    );
  }

  async create(options: PasskeyCreateOptions): Promise<CreatedPasskey> {
    const credential = await this.run(() =>
      navigator.credentials.create({
        publicKey: {
          challenge: fromBase64Url(options.challenge),
          rp: options.rp,
          user: {
            id: fromBase64Url(options.user.id),
            name: options.user.name,
            displayName: options.user.displayName,
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          excludeCredentials: options.excludeCredentials.map((id) => ({
            type: 'public-key' as const,
            id: fromBase64Url(id),
          })),
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required',
          },
          attestation: 'none',
          timeout: options.timeoutMs,
        },
      }),
    );
    const response = (credential as PublicKeyCredential | null)?.response;
    if (!(response instanceof AuthenticatorAttestationResponse))
      throw new PasskeyBrowserError('failed');
    return {
      attestationObject: toBase64Url(response.attestationObject),
      clientDataJSON: toBase64Url(response.clientDataJSON),
    };
  }

  async get(options: PasskeyGetOptions): Promise<UsedPasskey> {
    const credential = await this.run(() =>
      navigator.credentials.get({
        publicKey: {
          challenge: fromBase64Url(options.challenge),
          rpId: options.rpId,
          allowCredentials: options.credentialIds.map((id) => ({
            type: 'public-key' as const,
            id: fromBase64Url(id),
          })),
          userVerification: 'required',
          timeout: options.timeoutMs,
        },
      }),
    );
    const found = credential as PublicKeyCredential | null;
    const response = found?.response;
    if (found === null || !(response instanceof AuthenticatorAssertionResponse))
      throw new PasskeyBrowserError('failed');
    return {
      credentialId: toBase64Url(found.rawId),
      authenticatorData: toBase64Url(response.authenticatorData),
      clientDataJSON: toBase64Url(response.clientDataJSON),
      signature: toBase64Url(response.signature),
    };
  }

  private async run<T>(call: () => Promise<T>): Promise<T> {
    if (!this.supported) throw new PasskeyBrowserError('unsupported');
    try {
      return await call();
    } catch (error) {
      // The person closed the prompt, or took too long: not an error worth a scare.
      const name = (error as { name?: unknown }).name;
      throw new PasskeyBrowserError(
        name === 'NotAllowedError' || name === 'AbortError'
          ? 'cancelled'
          : 'failed',
      );
    }
  }
}
