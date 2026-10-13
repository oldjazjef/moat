import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { EMPTY_PROGRESS } from '../../setup/domain/setup';
import { JsonSetupProgress, SETUP_FILE } from './json-setup-progress';

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'moat-setup-'));
  const config = {
    get: () => dir,
  } as unknown as ConfigService<Env, true>;
  return { dir, progress: new JsonSetupProgress(config) };
}

describe('JsonSetupProgress', () => {
  it('reads a fresh start when there is no file', () => {
    expect(store().progress.read()).toEqual(EMPTY_PROGRESS);
  });

  it('writes and reads back, readable only by the owner', () => {
    const { dir, progress } = store();
    const saved = {
      steps: { language: 'done', gate: 'skipped' },
      currentStep: 'project',
      completedAt: '2026-10-13T08:00:00.000Z',
    } as const;
    progress.write(saved);
    expect(progress.read()).toEqual(saved);
    if (process.platform !== 'win32')
      expect(statSync(join(dir, SETUP_FILE)).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(readFileSync(join(dir, SETUP_FILE), 'utf8')).version,
    ).toBe(1);
  });

  it('drops what it does not know and never reads a damaged file as finished', () => {
    const { dir, progress } = store();
    writeFileSync(
      join(dir, SETUP_FILE),
      JSON.stringify({
        steps: { language: 'done', profile: 'done', gate: 'maybe' },
        currentStep: 'elsewhere',
        completedAt: 'yesterday',
      }),
    );
    expect(progress.read()).toEqual({
      steps: { language: 'done' },
      currentStep: 'language',
      completedAt: null,
    });
    writeFileSync(join(dir, SETUP_FILE), '{"steps":');
    expect(progress.read()).toEqual(EMPTY_PROGRESS);
  });
});
