import {
  IsIn,
  IsObject,
  IsOptional,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import {
  SETUP_STEPS,
  type SetupStepId,
  STEP_STATES,
  type StepState,
} from '../domain/setup';

/** `{ <step>: <state> }` with known steps and states only. */
function IsStepStates(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isStepStates',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          Object.entries(value).every(
            ([id, state]) =>
              (SETUP_STEPS as readonly string[]).includes(id) &&
              (STEP_STATES as readonly unknown[]).includes(state),
          ),
        defaultMessage: () =>
          `states must map steps (${SETUP_STEPS.join(', ')}) to ${STEP_STATES.join(' | ')}`,
      },
    },
    options,
  );
}

export class UpdateSetupDto {
  @IsOptional()
  @IsIn(SETUP_STEPS)
  currentStep?: SetupStepId;

  @IsOptional()
  @IsObject()
  @IsStepStates()
  states?: Partial<Record<SetupStepId, StepState>>;
}
