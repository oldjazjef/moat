import { Command } from '@nestjs/cqrs';
import type { ConfigEdit, ConfigEditRefusal } from '../project.types';

export type EditConfigResult =
  | { readonly status: 'saved' }
  | { readonly status: 'not_found' }
  /** moat.yaml changed since `base` was read: nothing written (409). */
  | { readonly status: 'changed' }
  | {
      readonly status: 'refused';
      readonly code: ConfigEditRefusal;
      /**
       * For `value_invalid`: the refused fields, e.g. `path`, `origins.1`, `auth.name`; for
       * `upstream_in_use`: the routes that call the upstream.
       */
      readonly fields?: readonly string[];
    };

/**
 * One edit of a project's moat.yaml from Moat Desktop, based on the version the window showed
 * (`base` = ProjectView.configHash). It changes the config only: a gate sees it with the next
 * bundle, which still needs the signing key (`moat build`), so the window cannot change what a
 * gate enforces on its own.
 */
export class EditConfigCommand extends Command<EditConfigResult> {
  constructor(
    readonly id: string,
    readonly base: string,
    readonly edit: ConfigEdit,
  ) {
    super();
  }
}
