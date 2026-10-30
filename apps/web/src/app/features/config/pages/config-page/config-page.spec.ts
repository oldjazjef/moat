import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  openPage,
  PROJECT,
  projectRoutes,
} from '../../../../../testing/page-harness';
import { ConfigPage } from './config-page';

const YAML = `version: 1
gates:
  site:
    environment: production
routes: {}
`;
const HASH = 'a'.repeat(64);
const CONFIG_URL = `/api/projects/${PROJECT.id}/config`;

const text = (el: HTMLElement, selector: string) =>
  el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const http = () => TestBed.inject(HttpTestingController);
async function settle(harness: { detectChanges(): void }): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve));
    harness.detectChanges();
  }
}

const open = (query = '') =>
  openPage(
    `/app/projects/${PROJECT.id}/config${query}`,
    projectRoutes(ConfigPage),
    {
      [`/api/projects/${PROJECT.id}`]: PROJECT,
      [CONFIG_URL]: { text: YAML, hash: HASH },
    },
  );

function type(el: HTMLElement, value: string): void {
  const editor = el.querySelector('#config-text') as HTMLTextAreaElement;
  editor.value = value;
  editor.dispatchEvent(new Event('input'));
}

describe('moat.yaml editor', () => {
  it("shows the project's moat.yaml and marks the gate it was opened for", async () => {
    const { el } = await open('?gate=site');
    const editor = el.querySelector('#config-text') as HTMLTextAreaElement;
    expect(editor.value).toBe(YAML);
    expect(text(el, '[data-gate-marked]')).toContain('«site»');
    expect(text(el, '[data-gate-marked]')).toContain('Zeilen 3 bis 4');
    // The entry is selected: from its name to its last line.
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe(
      '  site:\n    environment: production',
    );
    // Nothing changed: nothing to save.
    expect(
      (el.querySelector('[data-config-save]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('says so when the gate is not under gates:', async () => {
    const { el } = await open('?gate=shop');
    expect(text(el, '[data-gate-not-in-file]')).toContain('«shop»');
  });

  it('saves the whole text against the hash it was loaded with, then reads the project again', async () => {
    const { el, harness } = await open();
    const next = `${YAML}# changed\n`;
    type(el, next);
    await settle(harness);
    (el.querySelector('[data-config-save]') as HTMLButtonElement).click();
    await settle(harness);
    const put = http().expectOne(CONFIG_URL);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ base: HASH, text: next });
    put.flush({ text: next, hash: 'b'.repeat(64) });
    await settle(harness);
    http().expectOne(`/api/projects/${PROJECT.id}`).flush(PROJECT);
    await settle(harness);
    expect(el.querySelector('[data-config-saved]')).not.toBeNull();
  });

  it('shows where a refused text is wrong, with the line to jump to, and keeps the text', async () => {
    const { el, harness } = await open();
    const broken = 'version: 1\nroutes: [\n';
    type(el, broken);
    await settle(harness);
    (el.querySelector('[data-config-save]') as HTMLButtonElement).click();
    await settle(harness);
    http()
      .expectOne(CONFIG_URL)
      .flush(
        {
          error: 'config_invalid',
          issues: [{ code: 'syntax', path: [], line: 2, column: 9 }],
        },
        { status: 422, statusText: 'Unprocessable' },
      );
    await settle(harness);
    expect(text(el, '[data-config-issue]')).toContain('Zeile 2, Spalte 9');
    expect(text(el, '[data-config-issue]')).toContain(
      'Fehler in der YAML-Schreibweise',
    );
    expect(
      (el.querySelector('#config-text') as HTMLTextAreaElement).value,
    ).toBe(broken);
    (el.querySelector('[data-issue-line]') as HTMLButtonElement).click();
    const editor = el.querySelector('#config-text') as HTMLTextAreaElement;
    expect(editor.selectionStart).toBe('version: 1\n'.length);
  });

  it('refuses to overwrite a file that changed on disk', async () => {
    const { el, harness } = await open();
    type(el, `${YAML}# mine\n`);
    await settle(harness);
    (el.querySelector('[data-config-save]') as HTMLButtonElement).click();
    await settle(harness);
    http()
      .expectOne(CONFIG_URL)
      .flush(
        { error: 'config_changed' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle(harness);
    expect(text(el, '[data-config-error]')).toContain('inzwischen geändert');
  });
});
