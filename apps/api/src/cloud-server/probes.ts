import type { Request, RequestHandler, Response } from 'express';

/**
 * `/healthz` and `/readyz` for the container runtime and the load balancer. Public by design and
 * outside the API's router (so outside the authorization matrix, which lists `/api/**`): they take
 * no input, read no data and answer a fixed body (T-84).
 *
 * - `/healthz`: the process is up and answers. Nothing else.
 * - `/readyz`: the database answers a trivial query and the process is not shutting down. The
 *   answer says `ready` or `unavailable`, never why (no driver message, no host, no version).
 */
export interface ProbeState {
  /** Resolves when the database answers; rejects or resolves false otherwise. */
  ready(): Promise<boolean>;
  draining(): boolean;
}

const READY_TIMEOUT_MS = 2000;

function answer(
  response: Response,
  status: number,
  body: string,
  head: boolean,
): void {
  response
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store');
  if (head) response.end();
  else response.end(body);
}

export function probes(state: ProbeState): RequestHandler {
  return (request: Request, response: Response, next): void => {
    if (request.path !== '/healthz' && request.path !== '/readyz')
      return next();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      return answer(response, 405, '{"status":"method_not_allowed"}', false);
    }
    const head = request.method === 'HEAD';
    if (request.path === '/healthz') {
      return answer(response, 200, '{"status":"ok"}', head);
    }
    if (state.draining()) {
      return answer(response, 503, '{"status":"unavailable"}', head);
    }
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    });
    void Promise.race([state.ready().catch(() => false), limit]).then((ok) => {
      clearTimeout(timer);
      if (ok) answer(response, 200, '{"status":"ready"}', head);
      else answer(response, 503, '{"status":"unavailable"}', head);
    });
  };
}
