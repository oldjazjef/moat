import { isAllowedUrl } from '../domain/providers';

/** The only way Moat Cloud talks to an identity provider; specs replace it. */
export abstract class OidcHttp {
  /** GET a JSON document. Rejects on any failure; never returns a partial body. */
  abstract getJson(url: string): Promise<unknown>;
  /** POST a form (`application/x-www-form-urlencoded`) and read a JSON answer. */
  abstract postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    basicAuth: string,
  ): Promise<unknown>;
}

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;

export class OidcHttpError extends Error {}

/**
 * fetch with the limits of an outgoing call that carries a secret: https (or this machine
 * outside production), no redirects, a short time limit, a size limit, JSON only. The URL comes
 * from the operator's configuration or from the provider's discovery document, and is checked
 * again here (T-105).
 */
export class FetchOidcHttp extends OidcHttp {
  constructor(
    private readonly allowLoopbackHttp: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super();
  }

  getJson(url: string): Promise<unknown> {
    return this.call(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  }

  postForm(
    url: string,
    form: Readonly<Record<string, string>>,
    basicAuth: string,
  ): Promise<unknown> {
    return this.call(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async call(url: string, init: RequestInit): Promise<unknown> {
    if (!isAllowedUrl(url, this.allowLoopbackHttp))
      throw new OidcHttpError('url');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        credentials: 'omit',
      });
    } catch {
      throw new OidcHttpError('network');
    }
    if (!response.ok) throw new OidcHttpError('status');
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_BYTES) throw new OidcHttpError('size');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new OidcHttpError('body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new OidcHttpError('size');
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new OidcHttpError('json');
    }
  }
}
