/**
 * `/api/setup` (FR-73) — a mirror of apps/api/src/setup (domain/setup.ts, SetupView). The web app
 * does not import the API; keep both in step.
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

export interface SetupStep {
  readonly id: SetupStepId;
  readonly required: boolean;
  readonly state: StepState;
}

export interface SetupView {
  readonly steps: readonly SetupStep[];
  readonly currentStep: SetupStepId;
  readonly completedAt: string | null;
  readonly complete: boolean;
  readonly missing: readonly SetupStepId[];
  readonly facts: { readonly projects: number; readonly gates: number };
}

export interface UpdateSetupRequest {
  readonly currentStep?: SetupStepId;
  readonly states?: Partial<Record<SetupStepId, StepState>>;
}

/** 422 bodies of `/api/setup…`. */
export type SetupErrorCode =
  'step_required' | 'step_incomplete' | 'setup_incomplete';
