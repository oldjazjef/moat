import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import {
  GateClientPort,
  type GateAnswer,
  type GateFailure,
  type GateRequest,
} from '../ports/gate-client.port';
import { addressAllowed } from './address-rules';

/** Connect and answer within this; a gate that needs longer is reported as `timeout`. */
export const TIMEOUT_MS = 20_000;
/** More than any gate error or test answer; a larger body is cut off (`truncated`). */
export const MAX_READ_BYTES = 64 * 1024;
export const MAX_EXCERPT = 2048;
/** The names that may reach loopback in development; any other name resolving there may not. */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * «Testen» (FR-73, T-59): one request to the gate, the way the website sends it — no cookies, no
 * Origin, no redirects followed, a timeout and a size limit. The host is resolved first, every
 * address checked (address-rules.ts) and the first one pinned for the connection, so a DNS answer
 * that changes in between cannot point it elsewhere. TLS is verified against the host's name.
 */
@Injectable()
export class HttpsGateClient extends GateClientPort {
  private readonly allowLoopback: boolean;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.allowLoopback =
      config.get('MOAT_GATE_TEST_LOOPBACK', { infer: true }) === 'true';
  }

  async send(request: GateRequest): Promise<GateAnswer> {
    const host = request.url.hostname.replace(/^\[|\]$/g, '');
    const loopback =
      this.allowLoopback && LOOPBACK_NAMES.has(request.url.hostname);
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      return { status: 'failed', reason: 'not_found' };
    }
    if (
      addresses.length === 0 ||
      !addresses.every(({ address }) => addressAllowed(address, loopback))
    )
      return { status: 'failed', reason: 'address_forbidden' };
    const pinned = addresses[0] as { address: string; family: number };
    return this.exchange(request, pinned);
  }

  private exchange(
    request: GateRequest,
    pinned: { address: string; family: number },
  ): Promise<GateAnswer> {
    const pin: LookupFunction = (_host, options, callback) => {
      if (typeof options === 'object' && options.all === true)
        (
          callback as (
            e: null,
            a: { address: string; family: number }[],
          ) => void
        )(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const send = request.url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<GateAnswer>((resolve) => {
      let settled = false;
      const done = (answer: GateAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
      const fail = (reason: GateFailure) => done({ status: 'failed', reason });
      const outgoing = send(
        request.url,
        {
          method: request.method,
          lookup: pin,
          agent: false,
          headers: {
            Accept: 'application/json',
            'User-Agent': 'MoatDesktop-Test',
            ...(request.body === null
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': String(Buffer.byteLength(request.body)),
                }),
          },
        },
        (response) => read(response, done),
      );
      const timer = setTimeout(() => {
        fail('timeout');
        outgoing.destroy();
      }, TIMEOUT_MS);
      outgoing.on('error', (error: NodeJS.ErrnoException) =>
        fail(failureOf(error)),
      );
      outgoing.end(request.body ?? undefined);
    });
  }
}

function read(response: IncomingMessage, done: (answer: GateAnswer) => void) {
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  const finish = () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const type = response.headers['content-type'];
    done({
      status: 'answered',
      httpStatus: response.statusCode ?? 0,
      contentType: typeof type === 'string' ? type.slice(0, 128) : null,
      excerpt: text.slice(0, MAX_EXCERPT),
      truncated: truncated || text.length > MAX_EXCERPT,
    });
  };
  response.on('data', (chunk: Buffer) => {
    if (truncated) return;
    const room = MAX_READ_BYTES - length;
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room));
      length = MAX_READ_BYTES;
      truncated = true;
      finish();
      response.destroy();
      return;
    }
    chunks.push(chunk);
    length += chunk.length;
  });
  response.on('end', finish);
  response.on('error', finish);
}

function failureOf(error: NodeJS.ErrnoException): GateFailure {
  const code = error.code ?? '';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'not_found';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code.includes('SELF_SIGNED') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'EPROTO'
  )
    return 'tls';
  return 'unreachable';
}
