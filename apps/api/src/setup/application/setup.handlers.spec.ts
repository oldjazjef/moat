import { applyRecipe, toBase64Url } from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../../project/testing/in-memory-projects';
import { InMemorySetupProgress } from '../testing/in-memory-setup-progress';
import {
  CompleteSetupCommand,
  CompleteSetupHandler,
  GetSetupHandler,
  UpdateSetupCommand,
  UpdateSetupHandler,
} from './setup.handlers';

const NOW = '2026-10-13T08:00:00.000Z';

function setup() {
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': {
      'moat.yaml': applyRecipe(
        'version: 1\nupstreams: {}\nroutes: {}\n',
        'hubspot-newsletter',
      ),
      'gates/www.json': JSON.stringify({
        moat: 'gate',
        v: 1,
        gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
        boxKey: toBase64Url(new Uint8Array(32).fill(5)),
      }),
      // Not a gate: never counted (§1.5).
      'gates/junk.json': '{}',
    },
  });
  const progress = new InMemorySetupProgress();
  return {
    registry,
    progress,
    get: new GetSetupHandler(progress, registry, files),
    update: new UpdateSetupHandler(progress, registry, files),
    complete: new CompleteSetupHandler(progress, registry, files),
  };
}

describe('setup wizard (FR-73)', () => {
  it('starts open at the language with the required steps marked', async () => {
    const { get } = setup();
    const view = await get.execute();
    expect(view.complete).toBe(false);
    expect(view.currentStep).toBe('language');
    expect(
      view.steps.map(({ id, required, state }) => [id, required, state]),
    ).toEqual([
      ['language', true, 'open'],
      ['signingKey', false, 'open'],
      ['project', true, 'open'],
      ['gate', false, 'open'],
      ['recipe', false, 'open'],
      ['summary', false, 'open'],
    ]);
    expect(view.missing).toEqual(['language', 'project']);
    expect(view.facts).toEqual({ projects: 0, gates: 0, routes: 0 });
  });

  it('stores states and the current step', async () => {
    const { update, progress } = setup();
    const result = await update.execute(
      new UpdateSetupCommand({
        currentStep: 'signingKey',
        states: { language: 'done' },
      }),
    );
    expect(result.status).toBe('ok');
    expect(progress.progress).toMatchObject({
      currentStep: 'signingKey',
      steps: { language: 'done' },
    });
  });

  it('lets optional steps be skipped, never required ones', async () => {
    const { update } = setup();
    expect(
      (
        await update.execute(
          new UpdateSetupCommand({ states: { gate: 'skipped' } }),
        )
      ).status,
    ).toBe('ok');
    expect(
      await update.execute(
        new UpdateSetupCommand({ states: { project: 'skipped' } }),
      ),
    ).toEqual({ status: 'refused', code: 'step_required' });
  });

  it('marks project, gate and recipe done only when they exist', async () => {
    const { update, registry } = setup();
    for (const step of ['project', 'gate', 'recipe'] as const) {
      expect(
        await update.execute(
          new UpdateSetupCommand({ states: { [step]: 'done' } }),
        ),
      ).toEqual({ status: 'refused', code: 'step_incomplete' });
    }
    registry.add('/sites/shop');
    const result = await update.execute(
      new UpdateSetupCommand({
        states: { project: 'done', gate: 'done', recipe: 'done' },
      }),
    );
    expect(result.status === 'ok' && result.view.facts).toEqual({
      projects: 1,
      gates: 1,
      routes: 1,
    });
  });

  it('finishes only with the required steps done, and stays finished', async () => {
    const { update, complete, registry, get } = setup();
    expect(await complete.execute(new CompleteSetupCommand(NOW))).toEqual({
      status: 'refused',
      code: 'setup_incomplete',
      missing: ['language', 'project'],
    });
    registry.add('/sites/shop');
    await update.execute(
      new UpdateSetupCommand({ states: { language: 'done', project: 'done' } }),
    );
    const done = await complete.execute(new CompleteSetupCommand(NOW));
    expect(done.status === 'ok' && done.view).toMatchObject({
      complete: true,
      completedAt: NOW,
      currentStep: 'summary',
    });
    // Opening the wizard again later («Einrichtung») does not undo it.
    await update.execute(new UpdateSetupCommand({ currentStep: 'language' }));
    expect((await get.execute()).complete).toBe(true);
    const again = await complete.execute(
      new CompleteSetupCommand('2026-10-14T08:00:00.000Z'),
    );
    expect(again.status === 'ok' && again.view.completedAt).toBe(NOW);
  });

  it('counts a desktop from before the wizard (projects, nothing stored) as set up', async () => {
    const { get, registry, update } = setup();
    registry.add('/sites/shop');
    expect((await get.execute()).complete).toBe(true);
    // Once anything is stored, only «Fertig» finishes it.
    await update.execute(new UpdateSetupCommand({ currentStep: 'language' }));
    expect((await get.execute()).complete).toBe(false);
  });
});
