import type { ConfigService } from '@nestjs/config';
import { applyRecipe } from '@moat/core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../../project/testing/in-memory-projects';
import {
  GateClientPort,
  type GateAnswer,
  type GateRequest,
} from '../ports/gate-client.port';
import { GateTestConfirmationPort } from '../ports/gate-test-confirmation.port';
import {
  SuggestPolicyHandler,
  SuggestPolicyQuery,
  TestGateCommand,
  TestGateHandler,
} from './gate-test.handlers';

const BASE = 'version: 1\nupstreams: {}\nroutes: {}\n';
const GATE = 'https://www.example.ch/moat-gate.php';
const BODY = '{"properties":{"email":"test@example.com"}}';

class FakeClient extends GateClientPort {
  readonly sent: GateRequest[] = [];
  async send(request: GateRequest): Promise<GateAnswer> {
    this.sent.push(request);
    return {
      status: 'answered',
      httpStatus: 201,
      contentType: 'application/json',
      excerpt: '{"id":"1"}',
      truncated: false,
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
  ({
    get: () => (loopback ? 'true' : 'false'),
  }) as unknown as ConfigService<Env, true>;

function setup(config = applyRecipe(BASE, 'hubspot-newsletter')) {
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': { 'moat.yaml': config },
    '/sites/empty': {},
  });
  const id = registry.add('/sites/shop').id;
  const empty = registry.add('/sites/empty').id;
  const client = new FakeClient();
  const confirmation = new FakeConfirmation();
  return {
    id,
    empty,
    client,
    confirmation,
    test: new TestGateHandler(
      registry,
      files,
      client,
      confirmation,
      env(false),
    ),
    policy: new SuggestPolicyHandler(registry, files),
  };
}

describe('«Testen» through the gate (FR-73, T-59)', () => {
  it("sends the route's method and path with the body to the gate, nothing else", async () => {
    const { id, client, test } = setup();
    const result = await test.execute(
      new TestGateCommand(id, GATE, 'newsletter', BODY, 'de-CH'),
    );
    expect(result).toMatchObject({
      status: 'sent',
      answer: { status: 'answered', httpStatus: 201 },
    });
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.url.href).toBe(`${GATE}/newsletter`);
    expect(client.sent[0]?.method).toBe('POST');
    expect(client.sent[0]?.body).toBe(BODY);
  });

  it('never sends for an unknown project, route, address or body', async () => {
    const { id, empty, client, test } = setup();
    const cases: [TestGateCommand, unknown][] = [
      [
        new TestGateCommand(
          'missingProject00000000',
          GATE,
          'newsletter',
          BODY,
          '',
        ),
        { status: 'not_found' },
      ],
      [
        new TestGateCommand('../../etc', GATE, 'newsletter', BODY, ''),
        { status: 'not_found' },
      ],
      [
        new TestGateCommand(empty, GATE, 'newsletter', BODY, ''),
        { status: 'refused', code: 'config_missing' },
      ],
      [
        new TestGateCommand(id, GATE, 'chat', BODY, ''),
        { status: 'refused', code: 'route_unknown' },
      ],
      [
        new TestGateCommand(id, GATE, '__proto__', BODY, ''),
        { status: 'refused', code: 'route_unknown' },
      ],
      [
        new TestGateCommand(
          id,
          'http://www.example.ch/moat-gate.php',
          'newsletter',
          BODY,
          '',
        ),
        { status: 'refused', code: 'url_invalid' },
      ],
      [
        new TestGateCommand(
          id,
          'http://127.0.0.1:8080/moat-gate.php',
          'newsletter',
          BODY,
          '',
        ),
        { status: 'refused', code: 'url_invalid' },
      ],
      [
        new TestGateCommand(id, GATE, 'newsletter', '{"email":', ''),
        { status: 'refused', code: 'body_invalid' },
      ],
    ];
    for (const [command, expected] of cases)
      expect(await test.execute(command)).toEqual(expected);
    expect(client.sent).toEqual([]);
  });

  it('sends nothing the person did not confirm outside the page (T-59)', async () => {
    const { id, client, confirmation, test } = setup();
    confirmation.answer = false;
    expect(
      await test.execute(
        new TestGateCommand(id, GATE, 'newsletter', BODY, 'en'),
      ),
    ).toEqual({ status: 'refused', code: 'not_confirmed' });
    expect(confirmation.asked).toEqual([`en ${GATE}/newsletter`]);
    expect(client.sent).toEqual([]);
  });

  it('refuses a damaged moat.yaml', async () => {
    const { id, client, test } = setup('version: 1\nroutes: [');
    expect(
      await test.execute(new TestGateCommand(id, GATE, 'newsletter', BODY, '')),
    ).toEqual({ status: 'refused', code: 'config_invalid' });
    expect(client.sent).toEqual([]);
  });
});

describe('the suggested policy (SEC-14)', () => {
  it("admits exactly the recipe's upstream path, method and secret", async () => {
    const { id, policy } = setup();
    const result = await policy.execute(new SuggestPolicyQuery(id));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.policy.upstreams).toEqual({
      'api.hubapi.com': {
        pathPrefixes: ['/crm/v3/objects/contacts'],
        methods: ['POST'],
        secrets: ['hubspot-token'],
      },
    });
  });

  it('answers not_found and config_missing', async () => {
    const { empty, policy } = setup();
    expect(
      await policy.execute(new SuggestPolicyQuery('missingProject00000000')),
    ).toEqual({ status: 'not_found' });
    expect(await policy.execute(new SuggestPolicyQuery(empty))).toEqual({
      status: 'refused',
      code: 'config_missing',
    });
  });
});
