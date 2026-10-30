import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ProjectModule } from '../project/project.module';
import { AiCompletionPort } from './ai/ai-completion.port';
import { ProviderSwitchingAiCompletion } from './ai/provider-switching.adapter';
import { ChatEngine } from './application/chat-engine';
import { ProposalDecisions } from './application/proposal-decisions';
import { ProposalStore } from './application/proposals';
import { AssistantController } from './assistant.controller';
import { McpServer } from './mcp/mcp-server';
import {
  AssistantConnectionPort,
  MainProcessConnection,
} from './ports/assistant-connection.port';
import { AssistantTools } from './tools/assistant-tools';

@Module({
  imports: [CqrsModule, ProjectModule],
  controllers: [AssistantController],
  providers: [
    ProposalStore,
    ProposalDecisions,
    AssistantTools,
    ChatEngine,
    McpServer,
    // The adapters take a defaulted fetch, so they are built by hand (lazy-koins gotcha).
    {
      provide: AiCompletionPort,
      useFactory: () => new ProviderSwitchingAiCompletion(),
    },
    MainProcessConnection,
    { provide: AssistantConnectionPort, useExisting: MainProcessConnection },
  ],
})
export class AssistantModule {}
