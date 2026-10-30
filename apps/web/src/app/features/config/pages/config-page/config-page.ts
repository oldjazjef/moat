import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HelpLink } from '../../../help/components/help-link';
import { ConfigPageService } from './config-page.service';
import { gateLines, lineOffset } from './config-lines';

@Component({
  selector: 'mt-config-page',
  imports: [TranslatePipe, NgIcon, HelpLink, ...HlmButtonImports],
  providers: [ConfigPageService, provideIcons({ lucideTriangleAlert })],
  templateUrl: './config-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigPage {
  protected readonly service = inject(ConfigPageService);
  /** `?gate=<name>`: the gate whose entry is marked when the file opens. */
  readonly gate = input<string>();

  private readonly editor =
    viewChild<ElementRef<HTMLTextAreaElement>>('editor');
  /** The gate's entry as lines (from 1), while the file has it. */
  protected readonly gateRange = computed(() => {
    const gate = this.gate();
    return gate === undefined || gate === ''
      ? null
      : gateLines(this.service.text(), gate);
  });
  protected readonly lineCount = computed(
    () => this.service.text().split('\n').length,
  );
  private readonly marked = signal(false);

  constructor() {
    // Once the file is there: select the gate's entry and scroll to it.
    afterRenderEffect(() => {
      const range = this.gateRange();
      const editor = this.editor()?.nativeElement;
      if (this.marked() || range === null || editor === undefined) return;
      this.marked.set(true);
      this.select(editor, range.from, range.to + 1);
    });
  }

  protected onInput(event: Event): void {
    this.service.edit((event.target as HTMLTextAreaElement).value);
  }

  /** An issue's «Zeile N»: the cursor goes there. */
  protected goTo(line: number): void {
    const editor = this.editor()?.nativeElement;
    if (editor !== undefined) this.select(editor, line, line + 1);
  }

  private select(editor: HTMLTextAreaElement, from: number, to: number): void {
    const text = editor.value;
    const start = lineOffset(text, from);
    const end = Math.max(start, lineOffset(text, to) - 1);
    editor.focus();
    editor.setSelectionRange(start, end);
    const lineHeight =
      Number.parseFloat(getComputedStyle(editor).lineHeight) || 20;
    editor.scrollTop = Math.max(0, (from - 3) * lineHeight);
  }
}
