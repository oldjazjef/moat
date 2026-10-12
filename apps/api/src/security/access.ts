import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** The header the desktop shell adds to every request it forwards from the window. */
export const DESKTOP_ACCESS_HEADER = 'x-moat-desktop';

type Middleware = (
  request: Request,
  response: Response,
  next: NextFunction,
) => void;

/** The same answer for every refusal: no hint which check failed. */
function forbid(response: Response): void {
  response.status(403).json({ statusCode: 403, error: 'forbidden' });
}

/**
 * DT-16 (T-52): the Host header must be exactly the address the API listens on. A web page that
 * re-points its own host name at 127.0.0.1 (DNS rebinding) sends its own name, and is refused
 * before anything else runs.
 */
export function requireHost(expected: () => string): Middleware {
  return (request, response, next) => {
    if (request.headers.host === expected()) {
      next();
      return;
    }
    forbid(response);
  };
}

/**
 * `AUTH_MODE=local` trusts its caller, and loopback is reachable by every program and every web
 * page on the machine: every request must carry the per-launch token that only the desktop shell
 * knows (as lazy-koins). Compared in constant time (CLAUDE.md, Security rules 11).
 */
export function requireAccessToken(expected: string): Middleware {
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (request, response, next) => {
    const given = request.headers[DESKTOP_ACCESS_HEADER];
    const givenBytes = Buffer.from(
      typeof given === 'string' ? given : '',
      'utf8',
    );
    if (
      givenBytes.length === expectedBytes.length &&
      timingSafeEqual(givenBytes, expectedBytes)
    ) {
      next();
      return;
    }
    forbid(response);
  };
}
