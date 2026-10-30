import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ChatEngine,
  type ConversationSummary,
  type ConversationView,
  proposalView,
  type ProposalView,
} from './application/chat-engine';
import { ProposalDecisions } from './application/proposal-decisions';
import { ProposalStore } from './application/proposals';
import { AskDto } from './dto/assistant.dto';
import {
  AssistantConnectionPort,
  type AssistantConnectionSummary,
} from './ports/assistant-connection.port';

/**
 * The assistant (Moat Desktop only, authz-matrix): conversations, questions, and the decisions
 * on proposals. Nothing here can sign, seal, pin, deploy or touch a key; a proposal applies one
 * moat.yaml edit the same way the page's own edits do.
 */
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly chat: ChatEngine,
    private readonly connection: AssistantConnectionPort,
    private readonly proposals: ProposalStore,
    private readonly decisions: ProposalDecisions,
  ) {}

  /** Whether a provider is set up (in the main process's own window), never the key. */
  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(): {
    configured: boolean;
    provider: AssistantConnectionSummary | null;
  } {
    const provider = this.connection.summary();
    return { configured: provider !== null, provider };
  }

  @Get('conversations')
  @Header('Cache-Control', 'no-store')
  conversations(): ConversationSummary[] {
    return this.chat.list();
  }

  @Post('conversations')
  @Header('Cache-Control', 'no-store')
  create(): ConversationView {
    return this.chat.create();
  }

  @Get('conversations/:id')
  @Header('Cache-Control', 'no-store')
  conversation(@Param('id') id: string): ConversationView {
    const view = this.chat.get(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    if (!this.chat.remove(id)) throw new NotFoundException();
  }

  /**
   * Asks the model. 409 `not_configured` without a provider; 502 with the provider's error code
   * and redacted details when the call failed (the conversation stays as it was).
   */
  @Post('conversations/:id/messages')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async ask(
    @Param('id') id: string,
    @Body() body: AskDto,
  ): Promise<ConversationView> {
    const result = await this.chat.ask(id, {
      text: body.text,
      projectId: body.projectId ?? null,
      locale: body.locale ?? 'de-CH',
    });
    switch (result.status) {
      case 'not_found':
        throw new NotFoundException();
      case 'not_configured':
        throw new ConflictException({ error: 'not_configured' });
      case 'failed':
        throw new BadGatewayException({
          error: result.code,
          details: result.details,
        });
      case 'ok':
        return result.conversation;
    }
  }

  /** Every proposal of this launch, newest first: the chat's and the MCP clients'. */
  @Get('proposals')
  @Header('Cache-Control', 'no-store')
  list(): ProposalView[] {
    return this.proposals.list().map(proposalView);
  }

  /** «Ausführen»: applies exactly the proposed edit to the version it was previewed against. */
  @Post('proposals/:id/confirm')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async confirm(@Param('id') id: string): Promise<ProposalView> {
    const result = await this.decisions.confirm(id);
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'decided')
      throw new ConflictException({ error: 'already_decided' });
    return proposalView(result.proposal);
  }

  @Post('proposals/:id/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  cancel(@Param('id') id: string): ProposalView {
    const result = this.decisions.cancel(id);
    if (result.status === 'not_found') throw new NotFoundException();
    if (result.status === 'decided')
      throw new ConflictException({ error: 'already_decided' });
    return proposalView(result.proposal);
  }
}
