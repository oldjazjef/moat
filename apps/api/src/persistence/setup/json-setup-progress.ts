import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import {
  EMPTY_PROGRESS,
  SETUP_STEPS,
  type SetupProgress,
  type SetupStepId,
  STEP_STATES,
  type StepState,
} from '../../setup/domain/setup';
import { SetupProgressPort } from '../../setup/ports/setup-progress.port';

/** `<MOAT_DATA_DIR>/setup.json`. */
export const SETUP_FILE = 'setup.json';
const MAX_FILE_BYTES = 16 * 1024;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * The wizard's progress as one small JSON file next to the project list, written atomically
 * (temp file + rename, 0600). Anything it cannot read — missing, too big, damaged, unknown steps
 * or states — reads as a fresh start for that part, never as finished.
 */
@Injectable()
export class JsonSetupProgress extends SetupProgressPort {
  private readonly file: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.file = join(config.get('MOAT_DATA_DIR', { infer: true }), SETUP_FILE);
  }

  read(): SetupProgress {
    let value: unknown;
    try {
      if (statSync(this.file).size > MAX_FILE_BYTES) return EMPTY_PROGRESS;
      value = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return EMPTY_PROGRESS;
    }
    if (typeof value !== 'object' || value === null) return EMPTY_PROGRESS;
    const record = value as Record<string, unknown>;
    const steps: Partial<Record<SetupStepId, StepState>> = {};
    const stored = record['steps'];
    if (typeof stored === 'object' && stored !== null) {
      for (const id of SETUP_STEPS) {
        const state = (stored as Record<string, unknown>)[id];
        if ((STEP_STATES as readonly unknown[]).includes(state))
          steps[id] = state as StepState;
      }
    }
    const current = record['currentStep'];
    const completedAt = record['completedAt'];
    return {
      steps,
      currentStep: (SETUP_STEPS as readonly unknown[]).includes(current)
        ? (current as SetupStepId)
        : EMPTY_PROGRESS.currentStep,
      completedAt:
        typeof completedAt === 'string' && ISO_TIME.test(completedAt)
          ? completedAt
          : null,
    };
  }

  write(progress: SetupProgress): void {
    const dir = join(this.file, '..');
    mkdirSync(dir, { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(
        temp,
        `${JSON.stringify({ version: 1, ...progress }, null, 2)}\n`,
        { mode: 0o600 },
      );
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
