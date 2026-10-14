import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { HttpsGateClient, MAX_EXCERPT } from './https-gate-client';

const env = (loopback: boolean) =>
  ({
    get: () => (loopback ? 'true' : 'false'),
  }) as unknown as ConfigService<Env, true>;

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A fake gate on 127.0.0.1 that records what it got. */
async function fakeGate(
  answer: (body: string) => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  },
) {
  const seen: {
    method?: string;
    url?: string;
    headers?: Record<string, unknown>;
    body?: string;
  } = {};
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      Object.assign(seen, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      const out = answer(body);
      res.writeHead(out.status, {
        'Content-Type': 'application/json',
        ...out.headers,
      });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/moat-gate.php/newsletter`),
    seen,
  };
}

describe('HttpsGateClient (T-59)', () => {
  it('sends the request as the website would and reports the answer', async () => {
    const { url, seen } = await fakeGate(() => ({
      status: 503,
      body: '{"error":"gate_not_configured"}',
    }));
    const answer = await new HttpsGateClient(env(true)).send({
      url,
      method: 'POST',
      body: '{"a":1}',
    });
    expect(answer).toEqual({
      status: 'answered',
      httpStatus: 503,
      contentType: 'application/json',
      excerpt: '{"error":"gate_not_configured"}',
      truncated: false,
    });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/moat-gate.php/newsletter');
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers?.['content-type']).toBe('application/json');
    // No Origin, no cookie: nothing the website's visitors would not send either.
    expect(seen.headers?.['origin']).toBeUndefined();
    expect(seen.headers?.['cookie']).toBeUndefined();
  });

  it('never follows a redirect', async () => {
    const { url } = await fakeGate(() => ({
      status: 302,
      body: '',
      headers: { Location: 'http://169.254.169.254/latest/meta-data' },
    }));
    const answer = await new HttpsGateClient(env(true)).send({
      url,
      method: 'POST',
      body: '{}',
    });
    expect(answer).toMatchObject({ status: 'answered', httpStatus: 302 });
  });

  it('cuts a long answer off', async () => {
    const { url } = await fakeGate(() => ({
      status: 200,
      body: 'x'.repeat(200_000),
    }));
    const answer = await new HttpsGateClient(env(true)).send({
      url,
      method: 'POST',
      body: '{}',
    });
    expect(answer).toMatchObject({ status: 'answered', truncated: true });
    expect(answer.status === 'answered' && answer.excerpt.length).toBe(
      MAX_EXCERPT,
    );
  });

  it('refuses loopback outside development, and private addresses always', async () => {
    const { url, seen } = await fakeGate(() => ({ status: 200, body: '{}' }));
    expect(
      await new HttpsGateClient(env(false)).send({
        url,
        method: 'POST',
        body: '{}',
      }),
    ).toEqual({ status: 'failed', reason: 'address_forbidden' });
    expect(seen.method).toBeUndefined();
    for (const host of ['10.0.0.1', '169.254.169.254', '[fd00::1]'])
      expect(
        await new HttpsGateClient(env(true)).send({
          url: new URL(`https://${host}/moat-gate.php/newsletter`),
          method: 'POST',
          body: '{}',
        }),
      ).toEqual({ status: 'failed', reason: 'address_forbidden' });
  });

  it('says when nothing answers', async () => {
    const { url } = await fakeGate(() => ({ status: 200, body: '{}' }));
    server?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answer = await new HttpsGateClient(env(true)).send({
      url,
      method: 'POST',
      body: '{}',
    });
    expect(answer).toEqual({ status: 'failed', reason: 'unreachable' });
  });
});
