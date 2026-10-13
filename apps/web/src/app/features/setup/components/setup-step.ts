import { forwardRef, type Provider, type Type } from '@angular/core';

/**
 * What every step of the setup wizard (FR-73) offers the page: «Weiter» calls `submit()` — it
 * checks the step (and saves what it has to) and answers whether the wizard may move on.
 */
export abstract class SetupStepComponent {
  /** False = stay on the step (the step shows why). */
  abstract submit(): Promise<boolean>;
}

/** `providers: [provideSetupStep(() => MyStep)]` — lets the page find the step on screen. */
export function provideSetupStep(
  type: () => Type<SetupStepComponent>,
): Provider {
  return { provide: SetupStepComponent, useExisting: forwardRef(type) };
}
