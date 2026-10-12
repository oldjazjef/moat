import {
  addEnvironment,
  assignGate,
  buildBundle,
  checkPolicy,
  compileConfig,
  ConfigEditError,
  ConfigError,
  createKeyFile,
  fingerprint,
  formatIssue,
  gateLockState,
  loadMoatYaml,
  MoatRejection,
  openKeyFile,
  parsePolicy,
  parseStrictJson,
  sealSecret,
  setEnvironmentEnabled,
  setGateEnabled,
  suggestPolicy,
  fromBase64Url,
  type MoatConfig,
} from '@moat/core';
import {
  exists,
  list,
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
  NAME,
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

/**
 * `moat gate add <name> --gate-id=<id> --box-key=<key> [--env <environment>]` — pin a gate after
 * comparing fingerprints, optionally into an environment.
 */
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
  const environment = option(options, 'env');
  const configFile = option(options, 'config') ?? CONFIG_FILE;
  // Checked before anything is written, so a bad --env leaves no half-added gate.
  const edited =
    environment === undefined
      ? null
      : assignGate(readText(context, configFile), gate, environment);
  const file: GateFile = { moat: 'gate', v: 1, gateId, boxKey };
  writeFile(context, gatePath(gate), `${JSON.stringify(file, null, 2)}\n`, {
    overwrite: options['force'] === true,
  });
  if (edited !== null) {
    writeFile(context, configFile, edited, { overwrite: true });
    context.out(
      `Added gate ${gate} to environment ${environment} in ${configFile}.`,
    );
  }
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
        gate: gateName,
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
    const lock = gateLockState(config, gateName);
    if (!lock.enabled)
      context.out(
        `LOCKED (${lockReason(lock.gateLocked, lock.environment)}): once accepted, the gate refuses every request.`,
      );
  } finally {
    signer.secretKey.fill(0);
  }
}

function lockReason(gateLocked: boolean, environment: string | null): string {
  return gateLocked ? 'gate' : `environment ${environment ?? ''}`;
}

function editConfig(
  context: Context,
  options: Options,
  edit: (text: string) => string,
): MoatConfig {
  const file = option(options, 'config') ?? CONFIG_FILE;
  const text = edit(readText(context, file));
  writeFile(context, file, text, { overwrite: true });
  return loadMoatYaml(text);
}

/** The pinned gates (gates/<gate>.json) whose next bundle changes with this edit. */
function affectedGates(
  context: Context,
  match: (gate: string) => boolean,
): string[] {
  return list(context, 'gates')
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .filter((gate) => NAME.test(gate) && match(gate))
    .sort();
}

function nextStep(context: Context, gates: string[]): void {
  if (gates.length === 0) {
    context.out('No pinned gate is affected.');
    return;
  }
  context.out(
    'Takes effect with the next bundle. Build and accept one for each gate:',
  );
  for (const gate of gates)
    context.out(`  moat build ${gate} --key <file.moatkey>`);
}

/** `moat env add <environment>` — a new, empty environment in moat.yaml. */
export async function envAdd(
  context: Context,
  [environment]: string[],
  options: Options,
): Promise<void> {
  if (environment === undefined)
    throw new UsageError('usage: moat env add <environment>');
  editConfig(context, options, (text) => addEnvironment(text, environment));
  context.out(`Environment ${environment} is in moat.yaml.`);
}

function envSetEnabled(enabled: boolean) {
  return async (
    context: Context,
    [environment]: string[],
    options: Options,
  ): Promise<void> => {
    if (environment === undefined)
      throw new UsageError(
        `usage: moat env ${enabled ? 'enable' : 'disable'} <environment>`,
      );
    const config = editConfig(context, options, (text) =>
      setEnvironmentEnabled(text, environment, enabled),
    );
    context.out(
      `Environment ${environment} is ${enabled ? 'unlocked' : 'locked: every gate in it refuses every request'}.`,
    );
    nextStep(
      context,
      affectedGates(
        context,
        (gate) => gateLockState(config, gate).environment === environment,
      ),
    );
  };
}

/** `moat env disable <environment>` — lock every gate of the environment (signed in the bundle). */
export const envDisable = envSetEnabled(false);
/** `moat env enable <environment>` — lift the environment's lock. */
export const envEnable = envSetEnabled(true);

function gateSetEnabled(enabled: boolean) {
  return async (
    context: Context,
    [gateName]: string[],
    options: Options,
  ): Promise<void> => {
    if (gateName === undefined)
      throw new UsageError(
        `usage: moat gate ${enabled ? 'enable' : 'disable'} <gate>`,
      );
    readGate(context, gateName);
    const config = editConfig(context, options, (text) =>
      setGateEnabled(text, gateName, enabled),
    );
    const lock = gateLockState(config, gateName);
    context.out(
      enabled
        ? lock.enabled
          ? `Gate ${gateName} is unlocked.`
          : `Gate ${gateName} is unlocked, but its environment ${lock.environment ?? ''} is still locked.`
        : `Gate ${gateName} is locked: it will refuse every request.`,
    );
    nextStep(context, [gateName]);
  };
}

/** `moat gate disable <gate>` — lock one gate (signed in its next bundle). */
export const gateDisable = gateSetEnabled(false);
/** `moat gate enable <gate>` — lift the gate's own lock. */
export const gateEnable = gateSetEnabled(true);

/** `moat gate assign <gate> <environment> [--force]` — put a pinned gate into an environment. */
export async function gateAssign(
  context: Context,
  [gateName, environment]: string[],
  options: Options,
): Promise<void> {
  if (gateName === undefined || environment === undefined)
    throw new UsageError('usage: moat gate assign <gate> <environment>');
  readGate(context, gateName);
  const before = gateLockState(loadConfig(context, options), gateName).enabled;
  const config = editConfig(context, options, (text) =>
    assignGate(text, gateName, environment, options['force'] === true),
  );
  context.out(`Gate ${gateName} is in environment ${environment}.`);
  const after = gateLockState(config, gateName).enabled;
  if (before === after) return;
  context.out(
    after
      ? `Environment ${environment} is not locked: this gate is no longer locked.`
      : `Environment ${environment} is locked: so is this gate now.`,
  );
  nextStep(context, [gateName]);
}

export function describeError(error: unknown): string | null {
  if (error instanceof UsageError) return error.message;
  if (error instanceof ConfigEditError)
    return error.code === 'gate_in_other_environment'
      ? `${error.message} (--force moves it)`
      : error.message;
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
