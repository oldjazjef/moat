import { Component, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { messages } from '../../../../testing/page-harness';
import { HardeningCheck, STORAGE_PREFIX } from './hardening-check';

@Component({
  imports: [HardeningCheck],
  template: `<mt-hardening-check [project]="project()" [gate]="gate" />`,
})
class Host {
  readonly project = signal('proj1');
  readonly gate = 'production';
}

const URL_ = 'https://www.example.ch/moat-gate.php';
const FOLDER = `moat-data-${'0a'.repeat(16)}`;
const ENDPOINT = '/api/projects/proj1/hardening-check';

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideTranslateService(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const translate = TestBed.inject(TranslateService);
  translate.setTranslation('de-CH', messages('de-CH'));
  translate.use('de-CH');
  const fixture = TestBed.createComponent(Host);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const http = TestBed.inject(HttpTestingController);
  const type = (selector: string, value: string) => {
    const input = el.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = async () => {
    (el.querySelector('[data-hardening-run]') as HTMLButtonElement).click();
    await fixture.whenStable();
  };
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  };
  return { fixture, el, http, type, submit, settle };
}

beforeEach(() => localStorage.clear());

describe('mt-hardening-check (DT-07, §1.5)', () => {
  it('shows «Unsicher für Secrets» and the readable files, nothing more', async () => {
    const { el, http, type, submit, settle } = await render();
    type('[data-hardening-url]', URL_);
    type('[data-hardening-folder]', FOLDER);
    await submit();
    const request = http.expectOne(ENDPOINT);
    expect(request.request.body).toEqual({
      url: URL_,
      dataFolder: FOLDER,
      locale: 'de-CH',
    });
    request.flush({
      result: 'reachable',
      reachable: ['identity.php', 'policy.php'],
      reason: null,
    });
    await settle();
    const result = el.querySelector('[data-hardening-result]');
    expect(result?.getAttribute('data-result')).toBe('reachable');
    expect(
      el.querySelector('[data-hardening-level="unsafe"]')?.textContent,
    ).toContain('Unsicher für Secrets');
    expect(el.querySelector('[data-hardening-files]')?.textContent).toContain(
      'identity.php',
    );
  });

  it('claims no level when nothing is readable, and points to the check on the server', async () => {
    const { el, http, type, submit, settle } = await render();
    type('[data-hardening-url]', URL_);
    type('[data-hardening-folder]', FOLDER);
    await submit();
    http
      .expectOne(ENDPOINT)
      .flush({ result: 'blocked', reachable: [], reason: null });
    await settle();
    expect(el.querySelector('[data-hardening-level]')).toBeNull();
    expect(el.textContent).not.toContain('Basis');
    const text = el.querySelector('[data-hardening-result]')?.textContent;
    expect(text).toContain(`php moat-gate.php check --url=${URL_}`);
    expect(text).toContain(FOLDER);
  });

  it('refuses a malformed folder name before asking the API', async () => {
    const { el, http, type, submit } = await render();
    type('[data-hardening-url]', URL_);
    type('[data-hardening-folder]', '../moat-data');
    await submit();
    http.expectNone(ENDPOINT);
    expect(el.querySelector('[data-hardening-notice]')?.textContent).toContain(
      'moat-data-',
    );
  });

  it('explains a refusal and a failure to reach the gate', async () => {
    const { el, http, type, submit, settle } = await render();
    type('[data-hardening-url]', URL_);
    type('[data-hardening-folder]', FOLDER);
    await submit();
    http
      .expectOne(ENDPOINT)
      .flush({ error: 'not_confirmed' }, { status: 422, statusText: 'x' });
    await settle();
    expect(el.querySelector('[data-hardening-notice]')?.textContent).toContain(
      'nicht bestätigt',
    );
    await submit();
    http
      .expectOne(ENDPOINT)
      .flush({ result: 'failed', reachable: [], reason: 'tls' });
    await settle();
    expect(el.querySelector('[data-hardening-result]')?.textContent).toContain(
      'Zertifikat',
    );
  });

  it('remembers the address per project and gate, never the data folder', async () => {
    const { el, fixture, http, type, submit } = await render();
    type('[data-hardening-url]', URL_);
    type('[data-hardening-folder]', FOLDER);
    await submit();
    http.expectOne(ENDPOINT);
    const stored = localStorage.getItem(`${STORAGE_PREFIX}proj1.production`);
    expect(JSON.parse(stored ?? 'null')).toEqual({ url: URL_ });
    expect(stored).not.toContain(FOLDER);
    fixture.componentInstance.project.set('other');
    await fixture.whenStable();
    expect(
      (el.querySelector('[data-hardening-url]') as HTMLInputElement).value,
    ).toBe('');
    fixture.componentInstance.project.set('proj1');
    await fixture.whenStable();
    expect(
      (el.querySelector('[data-hardening-url]') as HTMLInputElement).value,
    ).toBe(URL_);
  });
});
