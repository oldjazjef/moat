import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { messages } from '../../../../../testing/page-harness';
import { HELP_SECTIONS } from '../../help-content';
import { HelpPage } from './help-page';

async function open(url: string) {
  const scrolled: string[] = [];
  // jsdom does not scroll; record which section was asked to.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'app/help', component: HelpPage }]),
      provideTranslateService(),
    ],
  });
  const translate = TestBed.inject(TranslateService);
  translate.setTranslation('de-CH', messages('de-CH'));
  translate.use('de-CH');
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
  return { harness, el: harness.routeNativeElement as HTMLElement, scrolled };
}

const sectionIds = (el: HTMLElement) =>
  [...el.querySelectorAll('section[id]')].map((section) => section.id);

describe('HelpPage (FR-71)', () => {
  it('shows the guide: TOC with deep links, every step with "Schritt N von M", the FAQ', async () => {
    const { el } = await open('/app/help');
    expect(el.querySelector('h1')?.textContent).toContain('Hilfe');
    const toc = [
      ...el.querySelectorAll<HTMLAnchorElement>('[data-help-toc] a'),
    ].map((a) => a.getAttribute('href'));
    // Moat Desktop: the sections that exist only in the Cloud are left out and not numbered.
    const ids = HELP_SECTIONS.filter((section) => section.only !== 'cloud').map(
      (section) => section.id,
    );
    expect(toc).toEqual([
      ...ids.map((id) => `/app/help#${id}`),
      '/app/help#faq',
    ]);
    expect(sectionIds(el)).toEqual([...ids, 'faq']);
    const total = ids.length;
    expect(el.querySelector('#gate [data-help-step]')?.textContent).toContain(
      `Schritt ${ids.indexOf('gate') + 1} von ${total}`,
    );
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('#gate h2')?.textContent).toContain(
      'Gate installieren',
    );
    expect(
      [...el.querySelectorAll('#gate [data-help-links] a')].map((a) =>
        a.getAttribute('href'),
      ),
    ).toEqual(['/app/projects']);
    expect(el.querySelectorAll('[data-help-faq]').length).toBeGreaterThan(0);
  });

  it('shows the desktop-only steps marked as such (Moat Desktop runs in local mode)', async () => {
    const { el } = await open('/app/help');
    expect(el.querySelector('#project')?.textContent).toContain('Nur Desktop');
  });

  it('Moat Cloud shows its own sections first and none of the desktop-only ones', async () => {
    window.__MT_ENV__ = { authMode: 'cloud' };
    try {
      const { el } = await open('/app/help');
      const ids = sectionIds(el);
      expect(ids.slice(0, 4)).toEqual([
        'account',
        'organisations',
        'cloudGates',
        'setup',
      ]);
      expect(
        el.querySelector('#account [data-help-step]')?.textContent,
      ).toContain(
        `Schritt 1 von ${HELP_SECTIONS.filter((section) => section.only !== 'desktop').length}`,
      );
      // «Registrieren» etc. are quoted labels of the Cloud pages; no desktop step is offered.
      expect(el.querySelector('#project')?.textContent).not.toContain(
        'Nur Desktop',
      );
      expect(
        el.querySelector('#account [data-help-links] a')?.getAttribute('href'),
      ).toBe('/app/account');
    } finally {
      delete window.__MT_ENV__;
    }
  });

  it('a deep link scrolls to its section, marks it and focuses its heading', async () => {
    const { el, scrolled } = await open('/app/help#trust');
    expect(scrolled).toEqual(['trust']);
    expect(
      el.querySelector('#trust')?.classList.contains('mt-help-highlight'),
    ).toBe(true);
    expect(document.activeElement).toBe(el.querySelector('#trust h2'));
  });

  it('the search filters sections (accent-insensitive) and says how many match', async () => {
    const { el, harness } = await open('/app/help');
    const input = el.querySelector<HTMLInputElement>('#help-search');
    if (!input) throw new Error('no search box');
    input.value = 'schlusseldatei';
    input.dispatchEvent(new Event('input'));
    harness.detectChanges();
    expect(sectionIds(el)).toContain('trust');
    expect(sectionIds(el)).not.toContain('limits');
    expect(el.querySelector('[data-help-results]')?.textContent).toMatch(
      /\d+ von \d+ Schritten/,
    );
    input.value = 'xyzzy';
    input.dispatchEvent(new Event('input'));
    harness.detectChanges();
    expect(sectionIds(el)).toEqual([]);
    expect(el.querySelector('[data-help-none]')).not.toBeNull();
  });
});
