import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  inject,
  input,
  untracked,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideArrowRight,
  lucideCheck,
  lucideCircleAlert,
  lucideCircleMinus,
} from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmSkeletonImports } from '@moat/ui/skeleton';
import type { SetupStepId } from '../../../../core/api/setup.types';
import { PageHeader } from '../../../../shared/components/page-header';
import { HelpLink } from '../../../help/components/help-link';
import { SetupStepComponent } from '../../components/setup-step';
import { GateStep } from '../../components/steps/gate-step';
import { KeyStep } from '../../components/steps/key-step';
import { LanguageStep } from '../../components/steps/language-step';
import { ProjectStep } from '../../components/steps/project-step';
import { RecipeStep } from '../../components/steps/recipe-step';
import { SummaryStep } from '../../components/steps/summary-step';
import { SetupPageService } from './setup-page.service';

/**
 * The setup wizard (FR-73) — `/app/setup`, `?step=<id>` opens a step directly. A step bar with
 * number, title and state; the current step in a card; «Zurück» / «Später» / «Weiter» fixed at
 * the bottom (as lazy-koins). Each step does its own work; the page only moves between them.
 */
@Component({
  selector: 'mt-setup-page',
  imports: [
    NgIcon,
    TranslatePipe,
    PageHeader,
    HelpLink,
    LanguageStep,
    KeyStep,
    ProjectStep,
    GateStep,
    RecipeStep,
    SummaryStep,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmSkeletonImports,
  ],
  providers: [
    SetupPageService,
    provideIcons({
      lucideArrowLeft,
      lucideArrowRight,
      lucideCheck,
      lucideCircleAlert,
      lucideCircleMinus,
    }),
  ],
  templateUrl: './setup-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetupPage {
  /** `?step=gate` — bound from the query. */
  readonly step = input<string>();
  protected readonly service = inject(SetupPageService);
  private readonly stepComponent = viewChild(SetupStepComponent);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  constructor() {
    effect(() => {
      const requested = this.step();
      untracked(() => void this.service.init(requested ?? null));
    });
    // Moving to another step puts the focus on its title (keyboard and screen readers).
    let first = true;
    effect(() => {
      this.service.current();
      if (first) {
        first = false;
        return;
      }
      untracked(() =>
        queueMicrotask(() => this.heading()?.nativeElement.focus()),
      );
    });
  }

  protected next(): void {
    void this.service.next(this.stepComponent());
  }

  protected goTo(id: SetupStepId): void {
    this.service.goTo(id);
  }
}
