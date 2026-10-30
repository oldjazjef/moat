import { Injectable } from '@nestjs/common';
import { ProjectService } from '../../project/project.service';
import { type Proposal, ProposalStore } from './proposals';

export type DecisionResult =
  | { readonly status: 'not_found' }
  /** Already decided, or forgotten. */
  | { readonly status: 'decided' }
  | { readonly status: 'ok'; readonly proposal: Proposal };

/**
 * «Ausführen» and «Verwerfen» of a proposal. Applies exactly the proposed edit to exactly the
 * version it was previewed against (its `base`): when moat.yaml changed since, nothing is
 * written and the proposal says `changed` (T-107). The edit goes through the same command as
 * the page's own edits, so it is validated, written and recorded in the history the same way.
 */
@Injectable()
export class ProposalDecisions {
  constructor(
    private readonly store: ProposalStore,
    private readonly projects: ProjectService,
  ) {}

  async confirm(id: string): Promise<DecisionResult> {
    if (this.store.get(id) === null) return { status: 'not_found' };
    const proposal = this.store.claim(id);
    if (proposal === null) return { status: 'decided' };
    try {
      const result = await this.projects.editConfig(
        proposal.projectId,
        proposal.base,
        proposal.edit,
      );
      switch (result.status) {
        case 'saved':
          proposal.status = 'done';
          break;
        case 'changed':
          proposal.status = 'changed';
          break;
        case 'not_found':
          proposal.status = 'failed';
          proposal.error = 'not_found';
          break;
        case 'refused':
          proposal.status = 'failed';
          proposal.error = result.code;
          break;
      }
    } catch {
      proposal.status = 'failed';
      proposal.error = 'not_writable';
    }
    return { status: 'ok', proposal };
  }

  cancel(id: string): DecisionResult {
    if (this.store.get(id) === null) return { status: 'not_found' };
    const proposal = this.store.claim(id);
    if (proposal === null) return { status: 'decided' };
    proposal.status = 'cancelled';
    return { status: 'ok', proposal };
  }
}
