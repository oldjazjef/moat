import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/** A piece of a help text: plain text, or a command / file name written as `…`. */
export interface TextSegment {
  readonly code: boolean;
  readonly text: string;
}

/** Splits `Run \`moat build\` now` into text and code segments. No HTML is ever interpreted. */
export function segments(text: string): readonly TextSegment[] {
  return text
    .split('`')
    .map((part, index) => ({ code: index % 2 === 1, text: part }))
    .filter((segment) => segment.text !== '');
}

/**
 * A translated text with its `…` parts shown as inline code — commands and file names in the
 * guide. Built from text nodes only (no `innerHTML`, as lazy-koins' help).
 */
@Component({
  selector: 'mt-rich-text',
  // One line on purpose: any whitespace around the parts would show up before a comma or period.
  // prettier-ignore
  template: `@for (segment of parts(); track $index) {@if (segment.code) {<code class="mt-inline-code">{{ segment.text }}</code>} @else {<ng-container>{{ segment.text }}</ng-container>}}`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RichText {
  readonly text = input.required<string>();
  protected readonly parts = computed(() => segments(this.text()));
}
