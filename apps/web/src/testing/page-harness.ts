import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Type } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  provideTranslateService,
  type TranslationObject,
  TranslateService,
} from '@ngx-translate/core';
import type { ProjectView } from '../app/core/api/project.types';

const I18N_DIR = [
  join(process.cwd(), 'public', 'i18n'),
  join(process.cwd(), 'apps', 'web', 'public', 'i18n'),
].find((dir) => existsSync(dir));

export const messages = (locale: string): TranslationObject =>
  JSON.parse(
    readFileSync(join(I18N_DIR ?? '', `${locale}.json`), 'utf8'),
  ) as TranslationObject;

/**
 * Opens a page at `url` with the real de-CH texts and answers its `GET /api/project` with `view`
 * (or an HTTP error). Returns the page's element after everything settled.
 */
export async function openPage(
  url: string,
  component: Type<unknown>,
  view: ProjectView | 'error',
): Promise<{ el: HTMLElement; harness: RouterTestingHarness }> {
  Element.prototype.scrollIntoView = () => undefined;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: url.replace(/^\//, ''), component }]),
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
  harness.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  const request = http.expectOne('/api/project');
  if (view === 'error') {
    request.flush(null, { status: 500, statusText: 'Server Error' });
  } else {
    request.flush(view);
  }
  await harness.fixture.whenStable();
  harness.detectChanges();
  return { el: harness.routeNativeElement as HTMLElement, harness };
}

/** A valid project: the HubSpot recipe, one gate with its secret sealed, bundle 3 built. */
export const PROJECT: ProjectView = {
  folder: '/home/eme/sites/example',
  project: {
    config: {
      status: 'valid',
      secretNames: ['hubspot-token'],
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
      },
    ],
  },
};
