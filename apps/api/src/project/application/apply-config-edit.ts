import {
  addEnvironment,
  applyRecipe,
  assignGate,
  removeRoute,
  removeUpstream,
  setEnvironmentEnabled,
  setGateEnabled,
  setRoute,
  setRouteEnabled,
  setUpstream,
} from '@moat/core';
import type { ConfigEdit } from '../project.types';

/** The edit as text → text, through the core's comment-preserving edits (config/edit.ts). */
export function applyConfigEdit(text: string, edit: ConfigEdit): string {
  switch (edit.op) {
    case 'addEnvironment':
      return addEnvironment(text, edit.environment);
    case 'lockEnvironment':
      return setEnvironmentEnabled(text, edit.environment, false);
    case 'unlockEnvironment':
      return setEnvironmentEnabled(text, edit.environment, true);
    case 'lockGate':
      return setGateEnabled(text, edit.gate, false);
    case 'unlockGate':
      return setGateEnabled(text, edit.gate, true);
    case 'assignGate':
      // Choosing another environment in the window is the explicit move the CLI asks `--move` for.
      return assignGate(text, edit.gate, edit.environment, true);
    case 'addRoute':
      return setRoute(text, edit.route, edit.definition, 'create');
    case 'updateRoute':
      return setRoute(text, edit.route, edit.definition, 'update');
    case 'removeRoute':
      return removeRoute(text, edit.route);
    case 'enableRoute':
      return setRouteEnabled(text, edit.route, true);
    case 'disableRoute':
      return setRouteEnabled(text, edit.route, false);
    case 'addUpstream':
      return setUpstream(
        text,
        edit.upstream,
        edit.upstreamDefinition,
        'create',
      );
    case 'updateUpstream':
      return setUpstream(
        text,
        edit.upstream,
        edit.upstreamDefinition,
        'update',
      );
    case 'removeUpstream':
      return removeUpstream(text, edit.upstream);
    case 'applyRecipe':
      return applyRecipe(
        text,
        edit.recipe,
        edit.origins === undefined ? {} : { origins: [...edit.origins] },
      );
  }
}
