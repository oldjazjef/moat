import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Type } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  provideTranslateService,
  type TranslationObject,
  TranslateService,
} from '@ngx-translate/core';
import type { ProjectView } from '../app/core/api/project.types';
import { ProjectWorkspace } from '../app/features/projects/pages/project-workspace/project-workspace';

const I18N_DIR = [
  join(process.cwd(), 'public', 'i18n'),
  join(process.cwd(), 'apps', 'web', 'public', 'i18n'),
].find((dir) => existsSync(dir));

export const messages = (locale: string): TranslationObject =>
  JSON.parse(
    readFileSync(join(I18N_DIR ?? '', `${locale}.json`), 'utf8'),
  ) as TranslationObject;

/** An HTTP answer the harness gives instead of a body. */
export interface HttpFailure {
  readonly failStatus: number;
}
export const fail = (status: number): HttpFailure => ({ failStatus: status });

/**
 * Opens `url` under `routes` with the real de-CH texts and answers every API request from
 * `answers` (URL → body, or `fail(status)`). Returns the routed element after everything settled.
 */
export async function openPage(
  url: string,
  routes: Routes,
  answers: Readonly<Record<string, unknown>>,
): Promise<{ el: HTMLElement; harness: RouterTestingHarness }> {
  Element.prototype.scrollIntoView = () => undefined;
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes),
      provideTranslateService(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const translate = TestBed.inject(TranslateService);
  translate.setTranslation('de-CH', messages('de-CH'));
  translate.use('de-CH');
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  const http = TestBed.inject(HttpTestingController);
  // Answer until nothing asks any more (a tab renders only once the workspace has its project).
  // A request can follow a resolved promise a macrotask later, so the page counts as quiet only
  // after two rounds in a row without one; under load a single empty round is not enough.
  let quiet = 0;
  for (let round = 0; round < 20 && quiet < 2; round += 1) {
    harness.detectChanges();
    // Not whenStable() here: an open request keeps the app unstable until it is answered.
    await new Promise((resolve) => setTimeout(resolve));
    const pending = http.match(() => true);
    quiet = pending.length === 0 ? quiet + 1 : 0;
    for (const request of pending) {
      const answer = answers[request.request.url];
      if (answer === undefined) {
        throw new Error(`Unexpected request ${request.request.url}`);
      }
      if (
        typeof answer === 'object' &&
        answer !== null &&
        'failStatus' in answer
      ) {
        const status = (answer as HttpFailure).failStatus;
        request.flush(null, { status, statusText: 'Error' });
      } else {
        request.flush(answer as object);
      }
    }
  }
  const open = http.match(() => true);
  if (open.length > 0) {
    // whenStable() would wait for these forever; name them instead of timing out.
    throw new Error(
      `Unanswered requests: ${open.map((r) => r.request.url).join(', ')}`,
    );
  }
  await harness.fixture.whenStable();
  harness.detectChanges();
  return { el: harness.routeNativeElement as HTMLElement, harness };
}

/** The workspace route with `component` as its tab, as the app nests them. */
export function projectRoutes(component: Type<unknown>): Routes {
  return [
    {
      path: 'app/projects/:id',
      component: ProjectWorkspace,
      children: [{ path: ':tab', component }],
    },
    { path: 'app/projects', children: [] },
  ];
}

/** Opens a tab of the PROJECT fixture's workspace, answering its request with `view`. */
export function openProjectTab(
  tab: string,
  component: Type<unknown>,
  view: ProjectView | HttpFailure,
): Promise<{ el: HTMLElement; harness: RouterTestingHarness }> {
  return openPage(
    `/app/projects/${PROJECT.id}/${tab}`,
    projectRoutes(component),
    {
      [`/api/projects/${PROJECT.id}`]: view,
    },
  );
}

/**
 * A valid project: the HubSpot recipe, one gate in environment production with its secret sealed,
 * bundle 3 built, nothing locked.
 */
export const PROJECT: ProjectView = {
  id: 'projectExample00000000',
  name: 'example',
  folder: '/home/eme/sites/example',
  configHash: 'a'.repeat(64),
  project: {
    config: {
      status: 'valid',
      secretNames: ['hubspot-token'],
      environments: [{ name: 'production', enabled: true, gates: ['site'] }],
      config: {
        version: 1,
        upstreams: {
          hubspot: {
            origin: 'https://api.hubapi.com',
            auth: { type: 'bearer', secret: 'hubspot-token' },
            timeoutMs: 10_000,
          },
        },
        routes: {
          newsletter: {
            method: 'POST',
            path: '/newsletter',
            upstream: 'hubspot',
            upstreamPath: '/crm/v3/objects/contacts',
            maxBodyBytes: 4096,
            contentTypes: ['application/json'],
            responseContentTypes: ['application/json'],
            enabled: true,
            origins: ['https://www.example.ch'],
            rateLimit: { requests: 5, windowSeconds: 600, per: 'ip' },
          },
        },
      },
    },
    gates: [
      {
        name: 'site',
        status: 'valid',
        gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
        trustMode: 'signed',
        boxKeyId: 'kid-site',
        boxKeyFingerprint: 'MOAT-ABCD-EFGH-IJKL',
        secrets: [{ name: 'hubspot-token', secretVersion: 2 }],
        missingSecrets: [],
        latestBundle: 3,
        lock: {
          environment: 'production',
          gateLocked: false,
          environmentLocked: false,
          enabled: true,
        },
        latestBundleLocked: false,
      },
    ],
  },
};

/** Lets pending promises and signals settle, then renders. */
export async function settle(harness: RouterTestingHarness): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

/** The one edit the page sent (`POST …/config/edits`), to check and answer. */
export function expectEdit(): ReturnType<HttpTestingController['expectOne']> {
  const request = TestBed.inject(HttpTestingController).expectOne(
    `/api/projects/${PROJECT.id}/config/edits`,
  );
  expect(request.request.method).toBe('POST');
  return request;
}
