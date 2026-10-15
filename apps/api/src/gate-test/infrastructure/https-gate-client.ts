import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SETUP_TOKEN_HEADER } from '@moat/core';
import type { Env } from '../../config/env';
import {
  GateClientPort,
  type GateAnswer,
  type GateFailure,
  type GateRequest,
  type ProbeReply,
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
    const raw = await this.resolveAndExchange(request);
    if (raw.status === 'failed') return raw;
    const text = raw.body.toString('utf8');
    return {
      status: 'answered',
      httpStatus: raw.httpStatus,
      contentType: raw.contentType,
      excerpt: text.slice(0, MAX_EXCERPT),
      truncated: raw.truncated || text.length > MAX_EXCERPT,
    };
  }

  /** A GET without a body, for the check from outside (DT-07); the caller wipes the body. */
  async probe(url: URL): Promise<ProbeReply> {
    const raw = await this.resolveAndExchange({
      url,
      method: 'GET',
      body: null,
    });
    if (raw.status === 'failed') return raw;
    return {
      status: 'answered',
      httpStatus: raw.httpStatus,
      contentEncoding: raw.contentEncoding,
      body: raw.body,
    };
  }

  /** The setup mode's GET (SEC-28, T-73): the same pinning and limits, plus the token header. */
  async setup(url: URL, token: string): Promise<ProbeReply> {
    const raw = await this.resolveAndExchange({
      url,
      method: 'GET',
      body: null,
      headers: { [SETUP_TOKEN_HEADER]: token },
    });
    if (raw.status === 'failed') return raw;
    return {
      status: 'answered',
      httpStatus: raw.httpStatus,
      contentEncoding: raw.contentEncoding,
      body: raw.body,
    };
  }

  private async resolveAndExchange(request: GateRequest): Promise<RawAnswer> {
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
  ): Promise<RawAnswer> {
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
    return new Promise<RawAnswer>((resolve) => {
      let settled = false;
      const done = (answer: RawAnswer): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
        return true;
      };
      const fail = (reason: GateFailure) => {
        done({ status: 'failed', reason });
      };
      const outgoing = send(
        request.url,
        {
          method: request.method,
          lookup: pin,
          agent: false,
          headers: {
            ...request.headers,
            Accept: 'application/json',
            // The marker must be found in the bytes as they are (DT-07): no compression.
            'Accept-Encoding': 'identity',
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

type RawAnswer =
  | {
      readonly status: 'answered';
      readonly httpStatus: number;
      readonly contentType: string | null;
      readonly contentEncoding: string | null;
      readonly body: Buffer;
      readonly truncated: boolean;
    }
  | { readonly status: 'failed'; readonly reason: GateFailure };

function read(response: IncomingMessage, done: (answer: RawAnswer) => boolean) {
  // Every byte read is wiped once the answer is built, or dropped (DT-07: a data file holds keys).
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const body = Buffer.concat(chunks);
    for (const chunk of chunks) chunk.fill(0);
    const type = response.headers['content-type'];
    const encoding = response.headers['content-encoding'];
    const accepted = done({
      status: 'answered',
      httpStatus: response.statusCode ?? 0,
      contentType: typeof type === 'string' ? type.slice(0, 128) : null,
      contentEncoding:
        typeof encoding === 'string' ? encoding.slice(0, 64) : null,
      body,
      truncated,
    });
    if (!accepted) body.fill(0);
  };
  response.on('data', (chunk: Buffer) => {
    if (finished) {
      chunk.fill(0);
      return;
    }
    const room = MAX_READ_BYTES - length;
    if (chunk.length > room) {
      chunks.push(Buffer.from(chunk.subarray(0, room)));
      chunk.fill(0);
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
  response.on('close', finish);
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
