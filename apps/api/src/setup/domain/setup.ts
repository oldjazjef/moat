/**
 * The setup wizard (FR-73) of Moat Desktop: hand-written domain types and the pure rules — which
 * steps there are, which are required, when a step may count as done, when the wizard is finished.
 * As lazy-koins' wizard; the Cloud's (per account, with passkeys) joins with its auth.
 */
export const SETUP_STEPS = [
  'language',
  'signingKey',
  'project',
  'gate',
  'summary',
] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const STEP_STATES = ['open', 'done', 'skipped', 'error'] as const;
export type StepState = (typeof STEP_STATES)[number];

export interface SetupProgress {
  readonly steps: Readonly<Partial<Record<SetupStepId, StepState>>>;
  readonly currentStep: SetupStepId;
  /** «Fertig» pressed (ISO time); null = the app opens the wizard. */
  readonly completedAt: string | null;
}

export const EMPTY_PROGRESS: SetupProgress = {
  steps: {},
  currentStep: 'language',
  completedAt: null,
};

/** What is actually there, read from the project list and folders, not from the step states. */
export interface SetupFacts {
  readonly projects: number;
  /** Pinned gates (`gates/*.json`) over all projects. */
  readonly gates: number;
}

export interface SetupStepDefinition {
  readonly id: SetupStepId;
  readonly required: boolean;
}

/**
 * Language and the first project are required: without a project there is nothing to work on.
 * The signing key and the first gate can wait («Später»): the key may live on another computer,
 * the gate may not be installed yet.
 */
const REQUIRED: readonly SetupStepId[] = ['language', 'project'];

export const STEP_DEFINITIONS: readonly SetupStepDefinition[] = SETUP_STEPS.map(
  (id) => ({ id, required: REQUIRED.includes(id) }),
);

export function isRequired(step: SetupStepId): boolean {
  return REQUIRED.includes(step);
}

/** Whether a step may be marked `done`: its facts exist. */
export function canMarkDone(step: SetupStepId, facts: SetupFacts): boolean {
  if (step === 'project') return facts.projects > 0;
  if (step === 'gate') return facts.gates > 0;
  return true;
}

/** Required steps that are not done, or whose facts went missing: what keeps «Fertig» refused. */
export function missingRequired(
  progress: SetupProgress,
  facts: SetupFacts,
): SetupStepId[] {
  return REQUIRED.filter(
    (step) => progress.steps[step] !== 'done' || !canMarkDone(step, facts),
  );
}
