import { DOCUMENT } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideChevronDown,
  lucideCircleHelp,
  lucideX,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmBadge } from '@moat/ui/badge';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { PageHeader } from '../../../../shared/components/page-header';
import { RichText } from '../../../../shared/components/rich-text';
import { HELP_FAQ_ANCHOR, helpKeys } from '../../help-content';
import { HelpPageService } from './help-page.service';

/** How long a section the user jumped to stays marked. */
const HIGHLIGHT_MS = 2500;
/** A second scroll after the jump, once the layout of a freshly loaded page has settled. */
const REALIGN_MS = 300;

/**
 * FR-71 Hilfe: the guide step by step — a table of contents (left column from `lg`, collapsible
 * above), a search over all texts, one card per step with what it is for, where it lives, the
 * numbered steps, tips and "Öffnen" links into the app, then the FAQ. `/app/help#<section>`
 * scrolls to a section and marks it (the contextual "?" links of other pages use that).
 */
@Component({
  selector: 'mt-help-page',
  imports: [
    RouterLink,
    NgIcon,
    TranslatePipe,
    PageHeader,
    RichText,
    HlmBadge,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [
    HelpPageService,
    provideIcons({
      lucideArrowRight,
      lucideChevronDown,
      lucideCircleHelp,
      lucideX,
    }),
  ],
  templateUrl: './help-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpPage {
  protected readonly service = inject(HelpPageService);
  protected readonly keys = helpKeys;
  protected readonly faqAnchor = HELP_FAQ_ANCHOR;
  private readonly document = inject(DOCUMENT);

  /** The table of contents below `lg` (a disclosure); from `lg` it is always shown. */
  protected readonly tocOpen = signal(false);
  /** The section marked after a jump (cleared after a moment). */
  protected readonly highlighted = signal<string | null>(null);

  private readonly fragment = toSignal(inject(ActivatedRoute).fragment, {
    initialValue: null,
  });
  private scrolled = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private realign: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // `/app/help#files` (a contextual link, the TOC, a bookmark): go there.
    effect(() => {
      const fragment = this.fragment();
      if (this.service.isTarget(fragment)) {
        untracked(() => this.service.reveal(fragment));
      }
    });
    // Scroll once the section is rendered (a cleared search renders it first), focus its heading.
    afterRenderEffect(() => {
      const target = this.service.target();
      if (!target || target.seq === this.scrolled) return;
      const element = this.document.getElementById(target.id);
      if (!element) return;
      this.scrolled = target.seq;
      element.scrollIntoView({ block: 'start' });
      // Right after a page load the layout still settles (sidebar, fonts): align once more.
      clearTimeout(this.realign);
      this.realign = setTimeout(
        () => element.scrollIntoView({ block: 'start' }),
        REALIGN_MS,
      );
      element
        .querySelector<HTMLElement>('[data-help-heading]')
        ?.focus({ preventScroll: true });
      this.highlighted.set(target.id);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.highlighted.set(null), HIGHLIGHT_MS);
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.timer);
      clearTimeout(this.realign);
    });
  }

  protected setQuery(value: string): void {
    this.service.query.set(value);
  }

  /** A TOC entry: jump there (also when the URL already has that fragment) and fold the TOC. */
  protected jump(id: string): void {
    this.service.reveal(id);
    this.tocOpen.set(false);
  }
}
