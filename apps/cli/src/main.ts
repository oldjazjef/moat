import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { UsageError, type Context } from './context';
import {
  build,
  describeError,
  envAdd,
  envDisable,
  envEnable,
  gateAdd,
  gateAssign,
  gateDisable,
  gateEnable,
  keygen,
  policySuggest,
  secretSeal,
  validate,
  type Options,
} from './commands';

/** Set by apps/cli/build.mjs from MOAT_VERSION / MOAT_COMMIT (the release workflow). */
declare const MOAT_BUILD: { version: string; commit: string } | undefined;
const BUILD =
  typeof MOAT_BUILD === 'undefined'
    ? { version: '0.0.0-dev', commit: 'unknown' }
    : MOAT_BUILD;

const HELP = `moat — Moat CLI (sign and seal locally; nothing here talks to a server)

  moat version                                       version and build commit of this CLI
  moat keygen <file.moatkey>                         new signing key (trust mode 1)
  moat validate [--config moat.yaml] [--policy p.json]
  moat policy suggest [--config moat.yaml]           narrowest gate policy for the config
  moat gate add <gate> --gate-id=<id> --box-key=<k> [--env <environment>]
                                                     pin a gate after comparing fingerprints
  moat gate assign <gate> <environment> [--force]    put a gate into an environment
  moat gate disable|enable <gate>                    lock or unlock one gate
  moat env add <environment>                         a new environment (dev, staging, …)
  moat env disable|enable <environment>              lock or unlock every gate in it
  moat secret seal <gate> <name> [--secret-version n] value from stdin or a hidden prompt
  moat build <gate> --key <file.moatkey> [--version n] [--policy p.json]

A lock takes effect with the gate's next bundle (moat build, then accept on the gate): a locked
gate refuses every request and forwards nothing.

Passphrases and secret values: MOAT_PASSPHRASE (passphrase only), piped stdin, or a hidden prompt.`;

type Command = (
  context: Context,
  args: string[],
  options: Options,
) => Promise<void>;

const COMMANDS: Record<string, Command> = {
  version: async (context) =>
    context.out(`moat ${BUILD.version} (${BUILD.commit})`),
  keygen,
  validate,
  'policy suggest': policySuggest,
  'gate add': gateAdd,
  'gate assign': gateAssign,
  'gate disable': gateDisable,
  'gate enable': gateEnable,
  'env add': envAdd,
  'env disable': envDisable,
  'env enable': envEnable,
  'secret seal': secretSeal,
  build,
};

let pipedLines: string[] | null = null;

async function readSecret(prompt: string): Promise<string> {
  if (
    prompt.toLowerCase().includes('passphrase') &&
    process.env['MOAT_PASSPHRASE'] !== undefined
  ) {
    return process.env['MOAT_PASSPHRASE'];
  }
  if (!process.stdin.isTTY) {
    // Piped: one value per line, so `printf 'a\na\n' | moat keygen k.moatkey` answers both prompts.
    if (pipedLines === null) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    }
    return pipedLines.shift() ?? '';
  }
  return hiddenPrompt(prompt);
}

function hiddenPrompt(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    const output = rl as unknown as { _writeToOutput: (text: string) => void };
    output._writeToOutput = (text: string) => {
      // Echo the prompt, never the typed characters.
      if (text.includes(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

export async function run(argv: string[], context: Context): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      policy: { type: 'string' },
      key: { type: 'string' },
      version: { type: 'string' },
      'secret-version': { type: 'string' },
      'gate-id': { type: 'string' },
      'box-key': { type: 'string' },
      env: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const two = positionals.slice(0, 2).join(' ');
  const [name, rest] = COMMANDS[two]
    ? [two, positionals.slice(2)]
    : [positionals[0] ?? '', positionals.slice(1)];
  const command = COMMANDS[name];
  if (values.help === true || command === undefined) {
    context.out(HELP);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  try {
    await command(context, rest, values);
    return 0;
  } catch (error) {
    const message = describeError(error);
    if (message === null) throw error;
    context.err(`moat: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  const context: Context = {
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readSecret,
    now: () => Math.floor(Date.now() / 1000),
  };
  run(process.argv.slice(2), context).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // Unexpected: say so without dumping values (SEC-34).
      process.stderr.write(
        `moat: unexpected error (${error instanceof Error ? error.name : 'unknown'})\n`,
      );
      if (error instanceof UsageError) process.exit(2);
      process.exit(1);
    },
  );
}
