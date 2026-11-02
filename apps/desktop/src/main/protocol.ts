import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { protocol } from 'electron';
import type { RunningApi } from './api-host';
import {
  APP_SCHEME,
  CONTENT_SECURITY_POLICY,
  contentTypeOf,
  DESKTOP_ENV_JS,
  forwardHeaders,
  routeRequest,
} from './lib/web-protocol';
import {
  DIALOG_SCHEME,
  dialogContentType,
  dialogFileOf,
} from './lib/dialog-protocol';

/** Must run before `app` is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
    // The dialog windows' static pages (lib/dialog-protocol.ts): no fetch, no streams.
    { scheme: DIALOG_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/**
 * Serves `moat-dialog://local/<page>`: exactly the files of the packaged `dialogs/` folder, read
 * by the main process (which reads app.asar); anything else is a 404.
 */
export function handleDialogScheme(dialogsDir: string): void {
  protocol.handle(DIALOG_SCHEME, async (request) => {
    const file = dialogFileOf(request.url);
    if (file === null) return new Response('Not found', { status: 404 });
    try {
      return new Response(await readFile(join(dialogsDir, file)), {
        headers: {
          'content-type': dialogContentType(file),
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const PAGE_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/**
 * Serves `app://moat/…`: the web build from `webRoot`, the generated env.js, and `/api/…`
 * forwarded to the in-process API with the per-launch access token (see web-protocol.ts).
 */
export function handleAppScheme(webRoot: string, api: RunningApi): void {
  const isFile = (file: string) => existsSync(file) && statSync(file).isFile();

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const route = routeRequest(url.pathname, webRoot, isFile);

    switch (route.kind) {
      case 'api': {
        const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
        // Node's fetch (not Electron's net): loopback must never go through a system proxy.
        const response = await fetch(
          `${api.baseUrl}${route.path}${url.search}`,
          {
            method: request.method,
            headers: forwardHeaders(
              request.headers.entries(),
              api.accessHeader,
              api.accessToken,
            ),
            body: hasBody ? request.body : undefined,
            redirect: 'manual',
            ...(hasBody ? { duplex: 'half' } : {}),
          } as RequestInit,
        );
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      case 'env':
        return new Response(DESKTOP_ENV_JS, {
          headers: {
            ...PAGE_HEADERS,
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      case 'index':
      case 'file': {
        const file =
          route.kind === 'file' ? route.file : join(webRoot, 'index.html');
        return new Response(await readFile(file), {
          headers: {
            ...PAGE_HEADERS,
            'content-type': contentTypeOf(file),
            // Unhashed files (i18n, env.js) change with every version; reading from disk is cheap.
            'cache-control': 'no-cache',
          },
        });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  });
}
