import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The page's single `<h1>` with an optional subtitle (as lazy-koins). Actions (the contextual "?",
 * "Neu laden") are projected into the right-hand slot. Pass translated text. It stays at the top
 * while the page scrolls (`mt-page-header` in styles.css).
 */
@Component({
  selector: 'mt-page-header',
  template: `
    <header class="mt-page-header">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0 flex-1 basis-48">
          <h1 class="truncate text-2xl font-semibold">{{ title() }}</h1>
          @if (subtitle(); as text) {
            <p class="text-muted-foreground text-sm">{{ text }}</p>
          }
        </div>
        <ng-content />
      </div>
    </header>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
}
