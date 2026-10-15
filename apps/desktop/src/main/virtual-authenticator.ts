import type { BrowserWindow } from 'electron';
import { app } from 'electron';

/**
 * A development and test aid, never in a packaged app: `MOAT_VIRTUAL_AUTHENTICATOR=1` gives a
 * passkey window a Chromium virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`: CTAP2,
 * internal transport, resident keys, user verification on and passing) so the ceremony can run
 * on a machine without a passkey. It is a software stand-in, not a real passkey: what it proves
 * is Moat's own handling of the ceremony, not any platform's authenticator.
 *
 * Every window has its own virtual device, so the credentials it creates are kept here (from the
 * `WebAuthn.credentialAdded` event) and loaded into the next window's device — one "device" for
 * the lifetime of the process. Without the variable, nothing of this runs and the windows use
 * only what the system offers.
 */

interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

const device = new Map<string, VirtualCredential>();

export function virtualAuthenticatorEnabled(): boolean {
  return !app.isPackaged && process.env['MOAT_VIRTUAL_AUTHENTICATOR'] === '1';
}

/** A new, empty device (tests: "the passkey is not on this machine"). */
export function forgetVirtualCredentials(): void {
  device.clear();
}

export function attachVirtualAuthenticator(window: BrowserWindow): void {
  if (!virtualAuthenticatorEnabled()) return;
  const debug = window.webContents.debugger;
  try {
    debug.attach('1.3');
  } catch {
    console.error('[desktop] virtual authenticator unavailable');
    return;
  }
  debug.on('message', (_event, method, params: unknown) => {
    if (method !== 'WebAuthn.credentialAdded') return;
    const credential = (params as { credential?: VirtualCredential })
      .credential;
    if (credential !== undefined)
      device.set(credential.credentialId, credential);
  });
  void (async () => {
    await debug.sendCommand('WebAuthn.enable');
    const { authenticatorId } = (await debug.sendCommand(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    )) as { authenticatorId: string };
    for (const credential of device.values())
      await debug.sendCommand('WebAuthn.addCredential', {
        authenticatorId,
        credential,
      });
  })().catch(() => {
    console.error('[desktop] virtual authenticator failed');
  });
}
