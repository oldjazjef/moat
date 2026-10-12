import {
  buildBundle,
  checkPolicy,
  compileConfig,
  ConfigError,
  createKeyFile,
  fingerprint,
  formatIssue,
  loadMoatYaml,
  MoatRejection,
  openKeyFile,
  parsePolicy,
  parseStrictJson,
  sealSecret,
  suggestPolicy,
  fromBase64Url,
  type MoatConfig,
} from '@moat/core';
import {
  exists,
  readJson,
  readText,
  UsageError,
  writeFile,
  type Context,
} from './context';
import {
  boxFingerprint,
  bundleDir,
  checkName,
  CONFIG_FILE,
  gatePath,
  lastVersion,
  readGate,
  readSealedSecrets,
  secretPath,
  type GateFile,
} from './project';

export type Options = Readonly<Record<string, string | boolean | undefined>>;

function option(options: Options, key: string): string | undefined {
  const value = options[key];
  if (value === true) throw new UsageError(`--${key} needs a value`);
  return value === false ? undefined : value;
}

function required(options: Options, key: string): string {
  const value = option(options, key);
  if (value === undefined) throw new UsageError(`--${key} is required`);
  return value;
}

function positiveInt(
  text: string | undefined,
  what: string,
  fallback: number,
): number {
  if (text === undefined) return fallback;
  if (!/^[1-9][0-9]{0,14}$/.test(text))
    throw new UsageError(`${what} must be a positive integer`);
  return Number(text);
}

function loadConfig(context: Context, options: Options): MoatConfig {
  return loadMoatYaml(
    readText(context, option(options, 'config') ?? CONFIG_FILE),
  );
}

async function passphrase(context: Context, prompt: string): Promise<string> {
  const value = await context.readSecret(prompt);
  if (value.length === 0) throw new UsageError('empty passphrase');
  return value;
}

/** `moat keygen <file.moatkey>` — a new Ed25519 signing key (trust mode 1), never printed. */
export async function keygen(
  context: Context,
  [file]: string[],
): Promise<void> {
  if (file === undefined || !file.endsWith('.moatkey'))
    throw new UsageError('usage: moat keygen <file.moatkey>');
  if (exists(context, file)) throw new UsageError(`${file} already exists`);
  const first = await passphrase(context, 'New passphrase: ');
  if (first.length < 12)
    throw new UsageError('the passphrase needs at least 12 characters');
  const second = await passphrase(context, 'Repeat passphrase: ');
  if (first !== second) throw new UsageError('the passphrases differ');
  const keyFile = await createKeyFile(first);
  writeFile(context, file, `${JSON.stringify(keyFile, null, 2)}\n`, {
    mode: 0o600,
  });
  const publicKey = fromBase64Url(keyFile.pk);
  context.out(
    `Wrote ${file} (keep it out of Git; the passphrase is not stored).`,
  );
  context.out(`Public key:   ${keyFile.pk}`);
  context.out(`Fingerprint:  ${await fingerprint('ed25519', publicKey)}`);
  context.out(
    'Pin it on the gate: php moat-gate.php install --signer=<public key>',
  );
}

/** `moat validate` — schema, references and (with --policy) the gate's local policy. */
export async function validate(
  context: Context,
  _args: string[],
  options: Options,
): Promise<void> {
  const config = loadConfig(context, options);
  const secretNames = Object.values(config.upstreams).flatMap((upstream) =>
    upstream.auth ? [upstream.auth.secret] : [],
  );
  const compiled = compileConfig(config, secretNames);
  const policyFile = option(options, 'policy');
  if (policyFile !== undefined)
    checkPolicy(
      compiled,
      parsePolicy(
        parseStrictJson(
          new TextEncoder().encode(readText(context, policyFile)),
        ),
      ),
    );
  context.out(
    `OK: ${Object.keys(compiled.routes).length} route(s), ${Object.keys(compiled.upstreams).length} upstream(s)` +
      (policyFile === undefined ? '' : ', within the policy'),
  );
}

/** `moat policy suggest` — the narrowest local policy for this config (SEC-14), to review. */
export async function policySuggest(
  context: Context,
  _args: string[],
  options: Options,
): Promise<void> {
  const config = loadConfig(context, options);
  const secretNames = Object.values(config.upstreams).flatMap((upstream) =>
    upstream.auth ? [upstream.auth.secret] : [],
  );
  context.out(
    JSON.stringify(suggestPolicy(compileConfig(config, secretNames)), null, 2),
  );
}

/** `moat gate add <name> --gate-id=<id> --box-key=<key>` — pin a gate after comparing fingerprints. */
export async function gateAdd(
  context: Context,
  [name]: string[],
  options: Options,
): Promise<void> {
  const gate = checkName('gate name', name);
  const gateId = required(options, 'gate-id');
  if (!/^[A-Za-z0-9_-]{22}$/.test(gateId))
    throw new UsageError(
      '--gate-id must be the 22-character id the gate printed',
    );
  const boxKey = required(options, 'box-key');
  const boxPublicKey = fromBase64Url(boxKey);
  if (boxPublicKey.length !== 32)
    throw new UsageError('--box-key must be a 32-byte base64url key');
  const file: GateFile = { moat: 'gate', v: 1, gateId, boxKey };
  writeFile(context, gatePath(gate), `${JSON.stringify(file, null, 2)}\n`, {
    overwrite: options['force'] === true,
  });
  const { fingerprint: print } = await boxFingerprint(boxPublicKey);
  context.out(`Wrote ${gatePath(gate)}.`);
  context.out(`Box key fingerprint: ${print}`);
  context.out(
    'Compare every group with what the gate printed (SEC-32). If one differs, delete the file.',
  );
}

/** `moat secret seal <gate> <name>` — reads the value from stdin, writes only ciphertext (SEC-31). */
export async function secretSeal(
  context: Context,
  [gateName, name]: string[],
  options: Options,
): Promise<void> {
  if (gateName === undefined || name === undefined)
    throw new UsageError('usage: moat secret seal <gate> <name>');
  const gate = readGate(context, gateName);
  checkName('secret name', name);
  const value = await context.readSecret(`Value of ${name}: `);
  if (value.length === 0) throw new UsageError('empty secret');
  if (/[\r\n\0]/.test(value))
    throw new UsageError('the secret contains a line break or NUL byte');
  const plaintext = new TextEncoder().encode(value);
  const sealed = await sealSecret(plaintext, gate.boxPublicKey, {
    gateId: gate.gateId,
    secretName: name,
    secretVersion: positiveInt(
      option(options, 'secret-version'),
      '--secret-version',
      1,
    ),
  });
  plaintext.fill(0);
  writeFile(
    context,
    secretPath(gateName, name),
    `${JSON.stringify(sealed, null, 2)}\n`,
    { overwrite: true },
  );
  context.out(
    `Sealed ${name} for gate ${gateName} → ${secretPath(gateName, name)} (only that gate can open it).`,
  );
}

/** `moat build <gate> --key <file.moatkey>` — compile, check and sign the next bundle. */
export async function build(
  context: Context,
  [gateName]: string[],
  options: Options,
): Promise<void> {
  if (gateName === undefined)
    throw new UsageError('usage: moat build <gate> --key <file.moatkey>');
  const gate = readGate(context, gateName);
  const config = loadConfig(context, options);
  const policyFile = option(options, 'policy');
  const policy =
    policyFile === undefined
      ? undefined
      : parsePolicy(
          parseStrictJson(
            new TextEncoder().encode(readText(context, policyFile)),
          ),
        );
  const version = positiveInt(
    option(options, 'version'),
    '--version',
    lastVersion(context, gateName) + 1,
  );
  if (version <= lastVersion(context, gateName)) {
    throw new UsageError(
      `version ${version} is not higher than the last built one (${lastVersion(context, gateName)})`,
    );
  }
  const keyFile = readJson(context, required(options, 'key'));
  const signer = await openKeyFile(
    keyFile,
    await passphrase(context, 'Passphrase: '),
  );
  try {
    const envelope = await buildBundle(
      {
        config,
        gateId: gate.gateId,
        secrets: readSealedSecrets(context, gateName),
        version,
        issuedAt: context.now(),
        ...(policy === undefined ? {} : { policy }),
      },
      [signer],
    );
    const file = `${bundleDir(gateName)}/${version}.json`;
    writeFile(context, file, envelope);
    context.out(
      `Signed bundle version ${version} for gate ${gateName} → ${file}`,
    );
    context.out(`Signer: ${signer.kid}`);
  } finally {
    signer.secretKey.fill(0);
  }
}

export function describeError(error: unknown): string | null {
  if (error instanceof UsageError) return error.message;
  if (error instanceof ConfigError)
    return error.issues.map(formatIssue).join('\n');
  if (error instanceof MoatRejection) {
    const hints: Partial<Record<string, string>> = {
      keyfile_locked: 'wrong passphrase',
      keyfile_invalid: 'not a valid key file',
      config_invalid:
        'the config is invalid for this gate (is every referenced secret sealed for it?)',
      policy_violation: 'the config goes beyond the gate policy',
      policy_invalid: 'the policy file is invalid',
    };
    return `${error.code}${hints[error.code] ? `: ${hints[error.code]}` : ''}`;
  }
  return null;
}
