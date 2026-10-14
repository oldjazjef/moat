/** One request to a gate on the person's own hosting («Testen», FR-73). */
export interface GateRequest {
  readonly url: URL;
  readonly method: string;
  /** JSON text, or null for a method without a body. */
  readonly body: string | null;
}

export type GateAnswer =
  | {
      readonly status: 'answered';
      readonly httpStatus: number;
      readonly contentType: string | null;
      /** The body's start as text (at most MAX_EXCERPT characters), for the person to read. */
      readonly excerpt: string;
      /** True when the body was longer than what was read. */
      readonly truncated: boolean;
    }
  | {
      readonly status: 'failed';
      readonly reason: GateFailure;
    };

export type GateFailure =
  /** The host resolves to an address the test may not reach (private, link-local, …). */
  | 'address_forbidden'
  /** No such host. */
  | 'not_found'
  | 'unreachable'
  | 'timeout'
  /** TLS failed: the certificate does not fit the host, or is not trusted. */
  | 'tls';

/**
 * One GET of the check from outside (DT-07): the raw body (at most MAX_READ_BYTES), for the API
 * to look for the data-file marker and wipe. Never handed to the page.
 */
export type ProbeReply =
  | {
      readonly status: 'answered';
      readonly httpStatus: number;
      /** `Content-Encoding` as the server sent it; anything but identity hides the bytes. */
      readonly contentEncoding: string | null;
      readonly body: Buffer;
    }
  | {
      readonly status: 'failed';
      readonly reason: GateFailure;
    };

/** Outbound HTTPS to the gate the person named; nothing else in the API calls out. */
export abstract class GateClientPort {
  abstract send(request: GateRequest): Promise<GateAnswer>;
  abstract probe(url: URL): Promise<ProbeReply>;
}
