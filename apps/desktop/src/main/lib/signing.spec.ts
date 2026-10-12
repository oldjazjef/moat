import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MESSAGES, pageLocale } from './messages';
import {
  MAX_KEY_FILE_BYTES,
  PassphraseVault,
  readKeyFile,
  type BundlePreview,
  type Keychain,
  type PrepareResult,
  type SignResult,
  SigningSession,
} from './signing';

const KID = 'hpJ_W-5BmWCxRC4DaLFNKQ';
const PK = Buffer.alloc(32, 9).toString('base64url');
const PREVIEW: BundlePreview = {
  project: 'shop',
  gate: 'site',
  version: 4,
  previousVersion: 3,
  locked: false,
  changes: [
    {
      kind: 'route',
      name: 'newsletter',
      change: 'changed',
      fields: [{ field: 'rateLimit.requests', before: '5', after: '9' }],
    },
  ],
  previous: 'verified',
  digest: 'digest-1',
};

/** A keychain that "encrypts" by reversing: enough to see nothing is stored in plain text. */
const keychain = (available = true): Keychain => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from([...text].reverse().join('')),
  decryptString: (sealed) => [...sealed.toString()].reverse().join(''),
});

function setup(options: { available?: boolean; key?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moat-signing-'));
  const keyPath = join(dir, 'release.moatkey');
  writeFileSync(keyPath, JSON.stringify({ moat: 'keyfile', kid: KID, pk: PK }));
  let stored: Record<string, string> = {};
  let path: string | null = options.key === undefined ? keyPath : options.key;
  let prepared: PrepareResult = { status: 'ready', preview: PREVIEW };
  const results: SignResult[] = [];
  const calls: { digest: string; passphrase: string }[] = [];
  const signers: (string | null)[] = [];
  const vault = new PassphraseVault(
    keychain(options.available),
    () => stored,
    (next) => (stored = next),
  );
  const session = new SigningSession({
    texts: MESSAGES['de-CH'].signDialog,
    prepare: (signer) => {
      signers.push(
        signer === null
          ? null
          : `${signer.kid}:${Buffer.from(signer.publicKey).toString('base64url')}`,
      );
      return Promise.resolve(prepared);
    },
    sign: (digest, _keyFile, passphrase) => {
      calls.push({ digest, passphrase });
      return Promise.resolve(
        results.shift() ?? { status: 'signed', version: 4, kid: KID },
      );
    },
    keyFilePath: () => path,
    chooseKeyFile: () => {
      path = keyPath;
      return Promise.resolve(keyPath);
    },
    vault,
  });
  return {
    dir,
    session,
    vault,
    calls,
    signers,
    results,
    stored: () => stored,
    setPrepared: (next: PrepareResult) => (prepared = next),
  };
}

describe('SigningSession', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });
  const open = async (options?: Parameters<typeof setup>[0]) => {
    const context = setup(options);
    dirs.push(context.dir);
    const step = await context.session.open();
    if (!('view' in step)) throw new Error('not open');
    return { ...context, view: step.view };
  };

  it('shows the preview against the chosen key, the key file and whether the keychain can remember (DT-15)', async () => {
    const { view, signers } = await open();
    expect(signers).toEqual([`${KID}:${PK}`]);
    expect(view).toMatchObject({
      project: 'shop',
      gate: 'site',
      version: 4,
      keyFile: { name: 'release.moatkey', kid: KID },
      remembered: false,
      canRemember: true,
      notice: null,
    });
    expect(JSON.stringify(view)).not.toContain('digest-1');
  });

  it('signs exactly the previewed digest and remembers the passphrase only when asked', async () => {
    const { session, calls, stored } = await open();
    expect(
      await session.confirm({ passphrase: 'correct horse', remember: true }),
    ).toEqual({ done: { status: 'signed', version: 4 } });
    expect(calls).toEqual([
      { digest: 'digest-1', passphrase: 'correct horse' },
    ]);
    expect(Object.keys(stored())).toEqual([KID]);
    expect(JSON.stringify(stored())).not.toContain('correct horse');

    // Next time: the field may stay empty; unticking forgets it.
    const again = session.view();
    expect(again.remembered).toBe(true);
    expect(await session.confirm({ passphrase: '', remember: false })).toEqual({
      done: { status: 'signed', version: 4 },
    });
    expect(calls[1]?.passphrase).toBe('correct horse');
    expect(stored()).toEqual({});
  });

  it('remembers nothing when the keychain is not available', async () => {
    const { session, stored, view } = await open({ available: false });
    expect(view.canRemember).toBe(false);
    await session.confirm({ passphrase: 'pw', remember: true });
    expect(stored()).toEqual({});
  });

  it('keeps the dialog open on a wrong passphrase and forgets a remembered one that fails', async () => {
    const { session, results, vault, stored } = await open();
    results.push({ status: 'key_refused', code: 'keyfile_locked' });
    expect(
      await session.confirm({ passphrase: 'wrong', remember: true }),
    ).toMatchObject({ view: { notice: 'keyfile_locked' } });
    expect(stored()).toEqual({});

    vault.remember(KID, 'old');
    results.push({ status: 'key_refused', code: 'keyfile_locked' });
    expect(
      await session.confirm({ passphrase: '', remember: true }),
    ).toMatchObject({
      view: { notice: 'remembered_failed', remembered: false },
    });
    expect(stored()).toEqual({});
  });

  it('asks for a key file and a passphrase before signing anything', async () => {
    const { session, calls, view, signers } = await open({ key: null });
    expect(view.keyFile).toBeNull();
    expect(
      await session.confirm({ passphrase: 'pw', remember: false }),
    ).toMatchObject({ view: { notice: 'key_missing' } });
    // Choosing a key previews again, now against that key's bundles.
    expect(await session.chooseKey()).toMatchObject({
      view: { keyFile: { name: 'release.moatkey' } },
    });
    expect(signers).toEqual([null, `${KID}:${PK}`]);
    expect(
      await session.confirm({ passphrase: '', remember: false }),
    ).toMatchObject({ view: { notice: 'passphrase_missing' } });
    expect(calls).toEqual([]);
  });

  it('shows the new preview instead of signing when the project changed', async () => {
    const { session, results, setPrepared, calls } = await open();
    results.push({ status: 'changed' });
    setPrepared({
      status: 'ready',
      preview: { ...PREVIEW, version: 5, digest: 'digest-2' },
    });
    expect(
      await session.confirm({ passphrase: 'pw', remember: false }),
    ).toMatchObject({ view: { notice: 'changed', version: 5 } });
    await session.confirm({ passphrase: 'pw', remember: false });
    expect(calls.map((call) => call.digest)).toEqual(['digest-1', 'digest-2']);
  });

  it('ends with what blocks the bundle when there is nothing to sign', async () => {
    const context = setup();
    dirs.push(context.dir);
    context.setPrepared({
      status: 'refused',
      code: 'secrets_missing',
      secrets: ['hubspot-token'],
    });
    expect(await context.session.open()).toEqual({
      done: {
        status: 'refused',
        code: 'secrets_missing',
        secrets: ['hubspot-token'],
      },
    });
  });
});

describe('readKeyFile', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'moat-key-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads a small regular file and the kid it names', () => {
    const path = join(dir, 'a.moatkey');
    writeFileSync(path, JSON.stringify({ kid: KID }));
    expect(readKeyFile(path)).toMatchObject({ path, kid: KID, signer: null });
    writeFileSync(path, JSON.stringify({ kid: KID, pk: PK }));
    expect(readKeyFile(path)?.signer?.publicKey).toHaveLength(32);
    writeFileSync(path, JSON.stringify({ kid: KID, pk: 'short' }));
    expect(readKeyFile(path)?.signer).toBeNull();
    writeFileSync(path, JSON.stringify({ kid: '../x' }));
    expect(readKeyFile(path)?.kid).toBeNull();
  });

  it('refuses a folder, a missing file and anything too big', () => {
    expect(readKeyFile(dir)).toBeNull();
    expect(readKeyFile(join(dir, 'missing'))).toBeNull();
    const big = join(dir, 'big.moatkey');
    writeFileSync(big, 'x'.repeat(MAX_KEY_FILE_BYTES + 1));
    expect(readKeyFile(big)).toBeNull();
  });
});

describe('dialog texts', () => {
  const shape = (value: unknown): unknown =>
    typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, shape(item)]),
        )
      : typeof value;

  it('exist in both languages with the same keys', () => {
    expect(shape(MESSAGES.en)).toEqual(shape(MESSAGES['de-CH']));
  });

  it('follow the page, and the system only for a language the page cannot have', () => {
    expect(pageLocale('en', 'de-CH')).toBe('en');
    expect(pageLocale('de-CH', 'en-US')).toBe('de-CH');
    expect(pageLocale('fr', 'de-AT')).toBe('de-CH');
    expect(pageLocale(42, 'en-US')).toBe('en');
  });
});
