/**
 * Electron end-to-end script for trust mode 2 on the desktop (run with
 * `xvfb-run -a node apps/desktop/scripts/passkey-e2e.mjs`, see CLAUDE.md). It drives the real
 * passkey windows — the same dialogs, preloads and main-process code as the app — against the
 * real in-process API, with a **Chromium virtual authenticator** standing in for a passkey
 * (main/virtual-authenticator.ts). That proves Moat's handling of the ceremony and the
 * verification of the result; it does not prove that any real platform authenticator works in
 * Electron, and it must never be reported as such.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { fromBase64Url, verifyBundle, WEBAUTHN_ALG } from '@moat/core';
import { startApi } from '../src/main/api-host';
import { readConfig, updateConfig } from '../src/main/lib/config';
import { MESSAGES } from '../src/main/lib/messages';
import { PASSKEY_ORIGIN, PASSKEY_RP_ID } from '../src/main/lib/passkey';
import { enrollPasskey, signWithPasskey } from '../src/main/passkey-flow';
import { registerPasskeyDialogIpc } from '../src/main/passkey-window';
import { forgetVirtualCredentials } from '../src/main/virtual-authenticator';

const appDir = process.env['MOAT_E2E_APP_DIR'] ?? '';
const recipe = process.env['MOAT_E2E_RECIPE'] ?? '';
const userData = mkdtempSync(join(tmpdir(), 'moat-e2e-'));
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const text = MESSAGES['de-CH'];

const results: string[] = [];
function check(condition: boolean, name: string): void {
  results.push(`${condition ? 'ok  ' : 'FAIL'} ${name}`);
  if (!condition) process.exitCode = 1;
}

async function until<T>(
  what: string,
  probe: () => Promise<T | null | false>,
  timeout = 20_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await Promise.race([
      probe().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (value !== null && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const windows = BrowserWindow.getAllWindows().map((window) =>
    window.webContents.getURL(),
  );
  throw new Error(`timed out: ${what} (windows: ${windows.join(' ')})`);
}

/** The passkey window once its dialog is rendered. */
function passkeyWindow(page: string): Promise<BrowserWindow> {
  console.log('waiting for', page);
  return until(`window ${page}`, async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      const url = window.webContents.getURL();
      if (!url.startsWith(`${PASSKEY_ORIGIN}/${page}`)) continue;
      const shown = await window.webContents.executeJavaScript(
        "document.getElementById('form') !== null && !document.getElementById('form').hidden",
      );
      if (shown === true) return window;
    }
    return null;
  });
}

const read = (window: BrowserWindow, id: string): Promise<string> =>
  window.webContents.executeJavaScript(
    `document.getElementById(${JSON.stringify(id)}).textContent`,
  );
const click = (window: BrowserWindow, id: string): Promise<unknown> =>
  window.webContents.executeJavaScript(
    `document.getElementById(${JSON.stringify(id)}).click()`,
    true,
  );
const visible = (window: BrowserWindow, id: string): Promise<boolean> =>
  window.webContents.executeJavaScript(
    `!document.getElementById(${JSON.stringify(id)}).hidden`,
  );

/** Closes every window (and with it the debugger sessions) before the process ends. */
function finish(code: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  setTimeout(() => app.exit(code), 300);
}

async function main(): Promise<void> {
  app.on('window-all-closed', () => undefined);
  await app.whenReady();
  const running = await startApi({
    appDir,
    dataDir: userData,
    packaged: false,
  });

  // A project with one gate and a sealed secret (ciphertext made up, never opened here).
  const folder = join(userData, 'shop');
  mkdirSync(join(folder, 'gates'), { recursive: true });
  mkdirSync(join(folder, 'secrets', 'site'), { recursive: true });
  writeFileSync(join(folder, 'moat.yaml'), readFileSync(recipe, 'utf8'));
  writeFileSync(
    join(folder, 'gates', 'site.json'),
    JSON.stringify({
      moat: 'gate',
      v: 1,
      gateId: GATE_ID,
      boxKey: Buffer.alloc(32, 7).toString('base64url'),
    }),
  );
  writeFileSync(
    join(folder, 'secrets', 'site', 'hubspot-token.json'),
    JSON.stringify({
      v: 1,
      alg: 'x25519-blake2b-xchacha20poly1305',
      secretVersion: 1,
      epk: Buffer.alloc(32, 1).toString('base64url'),
      nonce: Buffer.alloc(24, 2).toString('base64url'),
      ct: 'AAAA',
    }),
  );
  const { id } = await running.addProject(folder);
  registerPasskeyDialogIpc();
  const parent = new BrowserWindow({ show: false });
  const env = { parent, appDir, userData, running };

  // 1. The system offers no passkey (no virtual authenticator): plain "unavailable", nothing stored.
  delete process.env['MOAT_VIRTUAL_AUTHENTICATOR'];
  const bare = enrollPasskey(env, text);
  let window = await passkeyWindow('passkey-dialog.html');
  await click(window, 'create');
  await until('unavailable notice', async () =>
    (await visible(window, 'notice')) ? true : null,
  );
  check(
    (await read(window, 'notice')) === text.passkeyDialog.notices.unavailable,
    'no passkey on the system: the window says so plainly',
  );
  await click(window, 'cancel');
  check(
    JSON.stringify(await bare) === '{"status":"unavailable"}',
    'no passkey on the system: the page learns "unavailable"',
  );
  check(
    readConfig(userData).passkey === null,
    'nothing stored without a passkey',
  );

  // 2. Enrollment with the virtual authenticator.
  process.env['MOAT_VIRTUAL_AUTHENTICATOR'] = '1';
  forgetVirtualCredentials();
  const enrolling = enrollPasskey(env, text);
  window = await passkeyWindow('passkey-dialog.html');
  check(
    (await read(window, 'rpid')) === PASSKEY_RP_ID &&
      (await read(window, 'origin')) === PASSKEY_ORIGIN,
    'enrollment window shows the pinned rpId and origin',
  );
  check(
    window.webContents.getURL().startsWith('https://passkey.moat.invalid/'),
    'enrollment window runs on the passkey origin, not app://moat',
  );
  await click(window, 'create');
  await until('done', async () =>
    (await visible(window, 'done')) ? true : null,
  );
  const fingerprint = await read(window, 'fingerprint');
  const trustCommand = await read(window, 'trust');
  const stored = readConfig(userData).passkey;
  check(stored !== null, 'the passkey is stored in config.json');
  check(
    stored !== null &&
      Buffer.from(stored.publicKey, 'base64url').length === 65 &&
      trustCommand ===
        `php moat-gate.php trust --passkey=${stored.publicKey} --rp-id=${PASSKEY_RP_ID} --origin=${PASSKEY_ORIGIN}`,
    'the window shows the gate command with the 65-byte point',
  );
  check(
    /^MOAT(-[A-Z2-7]{4}){6}-[A-Z2-7]{2}$/.test(fingerprint),
    'and its fingerprint',
  );
  check(
    !JSON.stringify(readConfig(userData)).includes('privateKey'),
    'config.json holds no private key',
  );
  await click(window, 'cancel');
  const enrolled = await enrolling;
  check(enrolled.status === 'created', 'the page learns "created"');
  if (stored === null) throw new Error('no passkey, cannot go on');

  // 3. Signing with the passkey: the bundle verifies as the gate would verify it.
  const pinned = {
    kid: stored.kid,
    alg: WEBAUTHN_ALG,
    publicKey: fromBase64Url(stored.publicKey),
    rpId: stored.rpId,
    origins: [stored.origin],
  } as const;
  const bundlePath = join(folder, 'bundles', 'site', '1.json');
  const signing = signWithPasskey(env, id, 'site', text);
  window = await passkeyWindow('passkey-sign-dialog.html');
  check(
    (await read(window, 'gate')) === 'site',
    'signing window shows the gate',
  );
  check(
    (await read(window, 'passkey')).startsWith('MOAT-'),
    'signing window shows the passkey fingerprint',
  );
  await click(window, 'sign');
  const signed = await signing;
  check(
    JSON.stringify(signed) === '{"status":"signed","version":1}',
    'signed with the passkey (virtual authenticator)',
  );
  const verified = await verifyBundle(readFileSync(bundlePath), {
    gateId: GATE_ID,
    signers: [pinned],
    threshold: 1,
    currentVersion: 0,
    now: Math.floor(Date.now() / 1000),
    expiryEnabled: false,
  });
  check(
    verified.payload.version === 1,
    'the written bundle verifies against the pinned passkey',
  );
  check(
    JSON.parse(readFileSync(bundlePath, 'utf8')).sigs[0].alg === WEBAUTHN_ALG,
    'with a webauthn-es256 signature entry',
  );

  // 4. A pinned key that is not the one on the device: the assertion does not verify, nothing written.
  const other = await (async () => {
    // A second passkey on the same device, enrolled in its own ceremony.
    const again = enrollPasskey(env, text);
    const second = await passkeyWindow('passkey-dialog.html');
    await click(second, 'create');
    await until('done', async () =>
      (await visible(second, 'done')) ? true : null,
    );
    await click(second, 'cancel');
    await again;
    return readConfig(userData).passkey;
  })();
  if (other === null) throw new Error('no second passkey');
  // The settings now name the first passkey's credential with the second one's public key.
  updateConfig(userData, {
    passkey: { ...other, credentialId: stored.credentialId },
  });
  const wrong = signWithPasskey(env, id, 'site', text);
  window = await passkeyWindow('passkey-sign-dialog.html');
  await click(window, 'sign');
  await until('notice', async () =>
    (await visible(window, 'notice')) ? true : null,
  );
  check(
    (await read(window, 'notice')) ===
      text.passkeySignDialog.notices.assertion_invalid,
    'a signature by a key that is not the pinned one: refused in the window',
  );
  await click(window, 'cancel');
  await wrong;
  let two = false;
  try {
    readFileSync(join(folder, 'bundles', 'site', '2.json'));
    two = true;
  } catch {
    two = false;
  }
  check(!two, 'nothing was written for it (fail closed)');

  // 5. A device without the passkey: nothing is signed, nothing written.
  forgetVirtualCredentials();
  const missing = signWithPasskey(env, id, 'site', text);
  window = await passkeyWindow('passkey-sign-dialog.html');
  await click(window, 'sign');
  await until('notice', async () =>
    (await visible(window, 'notice')) ? true : null,
  );
  check(
    (await read(window, 'notice')) === text.passkeySignDialog.notices.cancelled,
    'a device without the passkey: the window says nothing was signed',
  );
  await click(window, 'cancel');
  check(
    (await missing).status === 'cancelled',
    'and the page learns "cancelled"',
  );

  console.log(results.join('\n'));
  console.log(process.exitCode === 1 ? 'E2E FAILED' : 'E2E OK');
  await running.close();
  finish(Number(process.exitCode ?? 0));
}

main().catch((error: unknown) => {
  console.log(results.join('\n'));
  console.error('E2E ERROR', error);
  finish(1);
});
