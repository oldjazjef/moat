import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { fingerprint, keyId, toBase64Url } from '@moat/core';
import type { Env } from '../../config/env';
import { InMemoryProjectRegistry } from '../../project/testing/in-memory-projects';
import {
  GateClientPort,
  type GateAnswer,
  type ProbeReply,
} from '../ports/gate-client.port';
import { GateTestConfirmationPort } from '../ports/gate-test-confirmation.port';
import { GateSetupCommand, GateSetupHandler } from './gate-setup.handler';

const GATE = 'https://www.example.ch/api/moat-gate.php';
// TEST ONLY: a planted token, asserted absent from every result and error.
const TOKEN = toBase64Url(new Uint8Array(32).fill(7));
const BOX = new Uint8Array(32).map((_, index) => index + 1);
const SIGNER = new Uint8Array(32).map((_, index) => 90 + index);

async function goodAnswer(change: Record<string, unknown> = {}) {
  return JSON.stringify({
    gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
    boxKey: toBase64Url(BOX),
    boxKeyFingerprint: await fingerprint('x25519', BOX),
    signers: [
      {
        kid: await keyId('ed25519', SIGNER),
        fingerprint: await fingerprint('ed25519', SIGNER),
      },
    ],
    threshold: 1,
    mode: 1,
    ...change,
  });
}

class FakeGate extends GateClientPort {
  readonly calls: { url: string; token: string }[] = [];
  readonly bodies: Buffer[] = [];
  constructor(private reply: () => ProbeReply) {
    super();
  }
  async send(): Promise<GateAnswer> {
    throw new Error('setup only reads');
  }
  async probe(): Promise<ProbeReply> {
    throw new Error('setup only reads');
  }
  async setup(url: URL, token: string): Promise<ProbeReply> {
    this.calls.push({ url: url.href, token });
    const reply = this.reply();
    if (reply.status === 'answered') this.bodies.push(reply.body);
    return reply;
  }
}

class FakeConfirmation extends GateTestConfirmationPort {
  answer = true;
  readonly asked: string[] = [];
  async confirm(target: URL, locale: string): Promise<boolean> {
    this.asked.push(`${locale} ${target.href}`);
    return this.answer;
  }
}

const env = (loopback: boolean) =>
  ({ get: () => (loopback ? 'true' : 'false') }) as unknown as ConfigService<
    Env,
    true
  >;

const answered = (
  httpStatus: number,
  text: string,
  contentEncoding: string | null = null,
): ProbeReply => ({
  status: 'answered',
  httpStatus,
  contentEncoding,
  body: Buffer.from(text),
});

function setup(reply: () => ProbeReply) {
  const registry = new InMemoryProjectRegistry();
  const id = registry.add('/sites/shop').id;
  const gate = new FakeGate(reply);
  const confirmation = new FakeConfirmation();
  const handler = new GateSetupHandler(
    registry,
    gate,
    confirmation,
    env(false),
  );
  return { id, gate, confirmation, handler };
}

describe('reading a gate’s identity from its setup mode (SEC-28, SEC-32, T-73)', () => {
  it('confirms the address, sends one GET to ?moat-setup with the token, and returns the identity', async () => {
    const text = await goodAnswer();
    const { id, gate, confirmation, handler } = setup(() =>
      answered(200, text),
    );
    const result = await handler.execute(
      new GateSetupCommand(id, GATE, TOKEN, 'de-CH'),
    );
    expect(result).toEqual({
      status: 'read',
      identity: {
        gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
        boxKey: toBase64Url(BOX),
        boxKeyFingerprint: await fingerprint('x25519', BOX),
        signers: [
          {
            kid: await keyId('ed25519', SIGNER),
            fingerprint: await fingerprint('ed25519', SIGNER),
          },
        ],
        threshold: 1,
        mode: 1,
      },
    });
    expect(confirmation.asked).toEqual([`de-CH ${GATE}?moat-setup`]);
    // The token travels in the header only, never in the address.
    expect(gate.calls).toEqual([{ url: `${GATE}?moat-setup`, token: TOKEN }]);
    expect(gate.calls[0]?.url).not.toContain(TOKEN);
    expect(gate.bodies.every((body) => body.every((byte) => byte === 0))).toBe(
      true,
    );
  });

  it('T-73: refuses an answer whose fingerprint is not the box key’s', async () => {
    const text = await goodAnswer({
      boxKeyFingerprint: await fingerprint('x25519', SIGNER),
    });
    const { id, handler } = setup(() => answered(200, text));
    expect(
      await handler.execute(new GateSetupCommand(id, GATE, TOKEN, '')),
    ).toEqual({ status: 'refused', code: 'answer_invalid' });
  });

  it('says the mode is off on the gate’s 404, whatever the reason', async () => {
    const { id, handler } = setup(() =>
      answered(404, '{"error":"not_found"}\n'),
    );
    expect(
      await handler.execute(new GateSetupCommand(id, GATE, TOKEN, '')),
    ).toEqual({ status: 'refused', code: 'setup_off' });
  });

  it('refuses other statuses, compressed bodies, extra keys and non-JSON as answer_invalid', async () => {
    const good = await goodAnswer();
    const replies = [
      answered(500, good),
      answered(200, good, 'gzip'),
      answered(200, await goodAnswer({ extra: 1 })),
      answered(200, '<html>Welcome</html>'),
      answered(200, ''),
    ];
    for (const reply of replies) {
      const { id, handler } = setup(() => reply);
      expect(
        await handler.execute(new GateSetupCommand(id, GATE, TOKEN, '')),
      ).toEqual({ status: 'refused', code: 'answer_invalid' });
    }
  });

  it('reports why no answer came', async () => {
    for (const reason of ['address_forbidden', 'tls', 'timeout'] as const) {
      const { id, handler } = setup(() => ({ status: 'failed', reason }));
      expect(
        await handler.execute(new GateSetupCommand(id, GATE, TOKEN, '')),
      ).toEqual({ status: 'failed', reason });
    }
  });

  it('sends nothing for an unknown project, a bad URL or token, or without confirmation (T-59)', async () => {
    const { id, gate, confirmation, handler } = setup(() => answered(200, ''));
    const cases: [GateSetupCommand, unknown][] = [
      [
        new GateSetupCommand('missingProject00000000', GATE, TOKEN, ''),
        { status: 'not_found' },
      ],
      [
        new GateSetupCommand('../../etc', GATE, TOKEN, ''),
        { status: 'not_found' },
      ],
      ...[
        'http://www.example.ch/moat-gate.php',
        'http://127.0.0.1:8080/moat-gate.php',
        'https://www.example.ch/api/',
        'https://www.example.ch/api/moat-gate.php?moat-setup',
        'https://www.example.ch/api/moat-gate.php?x=1',
        `https://www.example.ch/api/moat-gate.php?moat-setup=${TOKEN}`,
        'https://www.example.ch/api/moat-gate.php#x',
        'https://user:pw@www.example.ch/moat-gate.php',
        'ftp://www.example.ch/moat-gate.php',
      ].map((url): [GateSetupCommand, unknown] => [
        new GateSetupCommand(id, url, TOKEN, ''),
        { status: 'refused', code: 'url_invalid' },
      ]),
      ...[
        '',
        'short',
        `${TOKEN}A`,
        TOKEN.slice(1),
        `${TOKEN.slice(1)}+`,
        ` ${TOKEN.slice(1)}`,
      ].map((token): [GateSetupCommand, unknown] => [
        new GateSetupCommand(id, GATE, token, ''),
        { status: 'refused', code: 'token_invalid' },
      ]),
    ];
    for (const [command, expected] of cases)
      expect(await handler.execute(command)).toEqual(expected);
    expect(confirmation.asked).toEqual([]);
    confirmation.answer = false;
    expect(
      await handler.execute(new GateSetupCommand(id, GATE, TOKEN, '')),
    ).toEqual({ status: 'refused', code: 'not_confirmed' });
    expect(gate.calls).toEqual([]);
  });

  it('runs one read at a time', async () => {
    const { id, confirmation, handler } = setup(() => answered(404, ''));
    let release: (yes: boolean) => void = () => undefined;
    confirmation.confirm = () =>
      new Promise<boolean>((resolve) => (release = resolve));
    const first = handler.execute(new GateSetupCommand(id, GATE, TOKEN, ''));
    expect(
      await handler.execute(new GateSetupCommand(id, GATE, TOKEN, '')),
    ).toEqual({ status: 'refused', code: 'busy' });
    release(false);
    expect(await first).toEqual({ status: 'refused', code: 'not_confirmed' });
  });

  it('SEC-34: the token is in no result, whatever the outcome', async () => {
    const outcomes: ProbeReply[] = [
      answered(200, await goodAnswer()),
      answered(200, `{"echo":"${TOKEN}"}`),
      answered(404, TOKEN),
      answered(500, TOKEN),
      { status: 'failed', reason: 'unreachable' },
    ];
    for (const reply of outcomes) {
      const { id, handler } = setup(() => reply);
      const result = await handler.execute(
        new GateSetupCommand(id, GATE, TOKEN, 'en'),
      );
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });
});
