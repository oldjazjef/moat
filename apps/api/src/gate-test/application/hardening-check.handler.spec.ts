import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { InMemoryProjectRegistry } from '../../project/testing/in-memory-projects';
import {
  GateClientPort,
  type GateAnswer,
  type ProbeReply,
} from '../ports/gate-client.port';
import { GateTestConfirmationPort } from '../ports/gate-test-confirmation.port';
import {
  HardeningCheckCommand,
  HardeningCheckHandler,
} from './hardening-check.handler';

const GATE = 'https://www.example.ch/api/moat-gate.php';
const FOLDER = `moat-data-${'ab'.repeat(16)}`;
const KEY_FILE =
  '<?php http_response_code(404); exit; __halt_compiler();{"secretKey":"PLANTED-KEY"}';

/** A web host: answers per path, 404 for the rest; records every URL and keeps the bodies. */
class FakeHost extends GateClientPort {
  readonly urls: string[] = [];
  readonly bodies: Buffer[] = [];
  constructor(private readonly pages: Record<string, ProbeReply | string>) {
    super();
  }
  async send(): Promise<GateAnswer> {
    throw new Error('the check only probes');
  }
  async probe(url: URL): Promise<ProbeReply> {
    this.urls.push(url.href);
    const page = this.pages[url.pathname] ?? 'Not Found';
    if (typeof page !== 'string') return page;
    const body = Buffer.from(page);
    this.bodies.push(body);
    const status =
      url.pathname.endsWith('/moat-check') || page.includes('__halt')
        ? 200
        : 404;
    return {
      status: 'answered',
      httpStatus: status,
      contentEncoding: null,
      body,
    };
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

const GATE_ANSWER = '{"error":"not_found"}\n';

function setup(pages: Record<string, ProbeReply | string>) {
  const registry = new InMemoryProjectRegistry();
  const id = registry.add('/sites/shop').id;
  const host = new FakeHost(pages);
  const confirmation = new FakeConfirmation();
  const handler = new HardeningCheckHandler(
    registry,
    host,
    confirmation,
    env(false),
  );
  return { id, host, confirmation, handler };
}

describe('the check from outside in Moat Desktop (DT-07, SEC-49)', () => {
  it('probes /moat-check, the data folder and each data file next to the gate file', async () => {
    const { id, host, confirmation, handler } = setup({
      '/api/moat-gate.php/moat-check': GATE_ANSWER,
    });
    const result = await handler.execute(
      new HardeningCheckCommand(id, GATE, FOLDER, 'de-CH'),
    );
    expect(result).toEqual({
      status: 'checked',
      report: { result: 'blocked', reachable: [], reason: null },
    });
    expect(confirmation.asked).toEqual([`de-CH ${GATE}/moat-check`]);
    expect(host.urls[0]).toBe(`${GATE}/moat-check`);
    expect(host.urls[1]).toBe(`https://www.example.ch/api/${FOLDER}/`);
    expect(host.urls).toContain(
      `https://www.example.ch/api/${FOLDER}/identity.php`,
    );
    expect(host.urls.at(-1)).toBe(
      `https://www.example.ch/api/${FOLDER}/index.php`,
    );
    expect(
      host.urls.every((url) => url.startsWith('https://www.example.ch/api/')),
    ).toBe(true);
  });

  it('names a readable data file, never its content, and wipes the bytes (SEC-34)', async () => {
    const { id, host, handler } = setup({
      '/api/moat-gate.php/moat-check': GATE_ANSWER,
      [`/api/${FOLDER}/identity.php`]: KEY_FILE,
    });
    const result = await handler.execute(
      new HardeningCheckCommand(id, GATE, FOLDER, 'en'),
    );
    expect(result).toEqual({
      status: 'checked',
      report: {
        result: 'reachable',
        reachable: ['identity.php'],
        reason: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain('PLANTED-KEY');
    expect(host.bodies.every((body) => body.every((byte) => byte === 0))).toBe(
      true,
    );
  });

  it('reports why the gate did not answer, and probes nothing more', async () => {
    const { id, host, handler } = setup({
      '/api/moat-gate.php/moat-check': {
        status: 'failed',
        reason: 'address_forbidden',
      },
    });
    expect(
      await handler.execute(new HardeningCheckCommand(id, GATE, FOLDER, '')),
    ).toEqual({
      status: 'checked',
      report: { result: 'failed', reachable: [], reason: 'address_forbidden' },
    });
    expect(host.urls).toHaveLength(1);
  });

  it('says so when the URL does not answer like a gate, and sends nothing more there', async () => {
    const { id, host, handler } = setup({
      '/api/moat-gate.php/moat-check': '<html>Welcome</html>',
    });
    expect(
      await handler.execute(new HardeningCheckCommand(id, GATE, FOLDER, '')),
    ).toMatchObject({ status: 'checked', report: { result: 'not_gate' } });
    expect(host.urls).toEqual([`${GATE}/moat-check`]);
  });

  it('stops at the first probe that gets no answer, and claims nothing (failed)', async () => {
    const { id, host, handler } = setup({
      '/api/moat-gate.php/moat-check': GATE_ANSWER,
      [`/api/${FOLDER}/trust.php`]: { status: 'failed', reason: 'timeout' },
    });
    expect(
      await handler.execute(new HardeningCheckCommand(id, GATE, FOLDER, '')),
    ).toMatchObject({ status: 'checked', report: { result: 'failed' } });
    expect(host.urls.at(-1)).toBe(
      `https://www.example.ch/api/${FOLDER}/trust.php`,
    );
    expect(host.urls).toHaveLength(4);
  });

  it('counts a throttled or compressed answer as unchecked, never as blocked', async () => {
    for (const reply of [
      {
        status: 'answered' as const,
        httpStatus: 429,
        contentEncoding: null,
        body: Buffer.from('slow down'),
      },
      {
        status: 'answered' as const,
        httpStatus: 200,
        contentEncoding: 'gzip',
        body: Buffer.from([0x1f, 0x8b, 0, 0]),
      },
    ]) {
      const { id, handler } = setup({
        '/api/moat-gate.php/moat-check': GATE_ANSWER,
        [`/api/${FOLDER}/policy.php`]: reply,
      });
      expect(
        await handler.execute(new HardeningCheckCommand(id, GATE, FOLDER, '')),
      ).toMatchObject({ status: 'checked', report: { result: 'failed' } });
      expect(reply.body.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('runs one check at a time', async () => {
    const { id, confirmation, handler } = setup({
      '/api/moat-gate.php/moat-check': GATE_ANSWER,
    });
    let release: (yes: boolean) => void = () => undefined;
    confirmation.confirm = () =>
      new Promise<boolean>((resolve) => (release = resolve));
    const first = handler.execute(
      new HardeningCheckCommand(id, GATE, FOLDER, ''),
    );
    expect(
      await handler.execute(new HardeningCheckCommand(id, GATE, FOLDER, '')),
    ).toEqual({ status: 'refused', code: 'busy' });
    release(false);
    expect(await first).toEqual({ status: 'refused', code: 'not_confirmed' });
  });

  it('sends nothing for an unknown project, a bad URL or folder, or without confirmation (T-59)', async () => {
    const { id, host, confirmation, handler } = setup({});
    const cases: [HardeningCheckCommand, unknown][] = [
      [
        new HardeningCheckCommand('missingProject00000000', GATE, FOLDER, ''),
        { status: 'not_found' },
      ],
      [
        new HardeningCheckCommand('../../etc', GATE, FOLDER, ''),
        { status: 'not_found' },
      ],
      ...[
        'http://www.example.ch/moat-gate.php',
        'http://127.0.0.1:8080/moat-gate.php',
        'https://www.example.ch/api/',
        'https://www.example.ch/api/moat-gate.php?x=1',
        'https://user:pw@www.example.ch/moat-gate.php',
        'ftp://www.example.ch/moat-gate.php',
      ].map((url): [HardeningCheckCommand, unknown] => [
        new HardeningCheckCommand(id, url, FOLDER, ''),
        { status: 'refused', code: 'url_invalid' },
      ]),
      ...['moat-data-x', '../moat-data-' + 'a'.repeat(32), 'secrets', ''].map(
        (folder): [HardeningCheckCommand, unknown] => [
          new HardeningCheckCommand(id, GATE, folder, ''),
          { status: 'refused', code: 'folder_invalid' },
        ],
      ),
    ];
    for (const [command, expected] of cases)
      expect(await handler.execute(command)).toEqual(expected);
    expect(confirmation.asked).toEqual([]);
    confirmation.answer = false;
    expect(
      await handler.execute(new HardeningCheckCommand(id, GATE, FOLDER, '')),
    ).toEqual({ status: 'refused', code: 'not_confirmed' });
    expect(host.urls).toEqual([]);
  });
});
