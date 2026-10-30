import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ConfigEdit } from '../../project/project.types';
import type { DiffGap, DiffLine } from '../domain/line-diff';

/** Where a proposal came from: the chat in Moat Desktop or an MCP client on this machine. */
export type ProposalSource = 'chat' | 'mcp';

export type ProposalStatus =
  | 'pending'
  | 'done'
  | 'cancelled'
  /** moat.yaml changed after the proposal was made: nothing written, propose again. */
  | 'changed'
  | 'failed';

/**
 * A change to moat.yaml the assistant (or an MCP client) wants. Nothing is written until the
 * person presses «Ausführen» in Moat Desktop; then exactly this edit is applied to exactly the
 * version the preview was computed from (`base`), or nothing (T-107).
 */
export interface Proposal {
  readonly id: string;
  readonly source: ProposalSource;
  readonly conversationId: string | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly edit: ConfigEdit;
  /** configHash of the moat.yaml the preview was made from. */
  readonly base: string;
  readonly diff: readonly (DiffLine | DiffGap)[];
  /** The model's one-line reason, shown as its words, never as Moat's. */
  readonly reason: string;
  readonly createdAt: string;
  status: ProposalStatus;
  /** For `failed`: the refusal code of the edit (`config.errors.<code>` in the page). */
  error: string | null;
  decidedAt: string | null;
}

/** Bounded: a runaway model or MCP client cannot fill memory with proposals. */
export const MAX_PROPOSALS = 100;

/**
 * Proposals in memory, for this launch of Moat Desktop only: nothing about them is written to
 * disk, and quitting forgets the undecided ones (said so in the page).
 */
@Injectable()
export class ProposalStore {
  private readonly items = new Map<string, Proposal>();

  add(
    input: Omit<
      Proposal,
      'id' | 'createdAt' | 'status' | 'error' | 'decidedAt'
    >,
  ): Proposal {
    const proposal: Proposal = {
      ...input,
      id: randomBytes(16).toString('base64url'),
      createdAt: new Date().toISOString(),
      status: 'pending',
      error: null,
      decidedAt: null,
    };
    this.items.set(proposal.id, proposal);
    while (this.items.size > MAX_PROPOSALS) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
    return proposal;
  }

  get(id: string): Proposal | null {
    return this.items.get(id) ?? null;
  }

  /** Newest first. */
  list(
    filter: { pending?: boolean; conversationId?: string } = {},
  ): Proposal[] {
    return [...this.items.values()]
      .filter(
        (item) =>
          (filter.pending !== true || item.status === 'pending') &&
          (filter.conversationId === undefined ||
            item.conversationId === filter.conversationId),
      )
      .reverse();
  }

  /** Claims a pending proposal for a decision; null when it is gone or already decided. */
  claim(id: string): Proposal | null {
    const item = this.items.get(id);
    if (item === undefined || item.status !== 'pending') return null;
    item.status = 'failed';
    item.decidedAt = new Date().toISOString();
    return item;
  }

  forgetConversation(conversationId: string): void {
    for (const [id, item] of this.items)
      if (item.conversationId === conversationId) this.items.delete(id);
  }
}
