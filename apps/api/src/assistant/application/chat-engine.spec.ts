import { describe, expect, it } from 'vitest';
import { AiProviderError } from '../ai/ai-completion.port';
import {
  assistantSetup,
  CONFIG,
  PLANTED_KEY,
  PROJECT,
  turn,
} from '../testing/assistant-fixture';
import { MAX_TOOL_STEPS } from './chat-engine';

const ADD_STAGING = {
  projectId: PROJECT,
  edit: { op: 'addEnvironment', environment: 'staging' },
  reason: 'A staging environment for tests.',
};

describe('ChatEngine (T-107)', () => {
  it('runs read tools and answers', async () => {
    const setup = assistantSetup([
      turn('', [{ name: 'get_config', input: { projectId: PROJECT } }]),
      turn('Du hast eine Route.'),
    ]);
    const { id } = setup.chat.create();
    const result = await setup.chat.ask(id, {
      text: 'Was ist in meinem Projekt?',
      projectId: PROJECT,
      locale: 'de-CH',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.conversation.messages.map((m) => m.text)).toEqual([
      'Was ist in meinem Projekt?',
      'Du hast eine Route.',
    ]);
    expect(result.conversation.messages[1]?.tools).toEqual(['get_config']);
    const second = setup.ai.requests[1];
    const tool = second?.messages.find((m) => m.role === 'tool');
    expect(tool?.content).toContain('newsletter');
    expect(second?.system).toContain('"shop"');
    // The folder never reaches the model.
    expect(JSON.stringify(setup.ai.requests)).not.toContain('/home/someone');
  });

  it('files a proposal and writes nothing until «Ausführen»', async () => {
    const setup = assistantSetup([
      turn('', [{ name: 'propose_config_edit', input: ADD_STAGING }]),
      turn('Vorschlag erstellt.'),
    ]);
    const { id } = setup.chat.create();
    const result = await setup.chat.ask(id, {
      text: 'Füge staging hinzu',
      projectId: null,
      locale: 'de-CH',
    });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(setup.files.writes).toBe(0);
    const [proposal] = result.conversation.proposals;
    expect(proposal?.status).toBe('pending');
    expect(proposal?.diff.some((line) => line.kind === '+')).toBe(true);
    expect(result.conversation.messages[1]?.proposalIds).toEqual([
      proposal?.id,
    ]);

    const decided = await setup.decisions.confirm(proposal?.id ?? '');
    expect(decided.status).toBe('ok');
    expect(setup.files.writes).toBe(1);
    expect(setup.files.text).toContain('staging');
    // Comments stay.
    expect(setup.files.text).toContain('# the newsletter');
    // Decided once only.
    expect((await setup.decisions.confirm(proposal?.id ?? '')).status).toBe(
      'decided',
    );
  });

  it('writes nothing when moat.yaml changed after the proposal', async () => {
    const setup = assistantSetup();
    await setup.tools.call('propose_config_edit', ADD_STAGING, {
      source: 'mcp',
      conversationId: null,
    });
    const [proposal] = setup.store.list();
    setup.files.text = `${CONFIG}# edited by hand\n`;
    const result = await setup.decisions.confirm(proposal?.id ?? '');
    expect(result.status === 'ok' && result.proposal.status).toBe('changed');
    expect(setup.files.text).not.toContain('staging');
  });

  it('refuses an edit outside the closed list or with extra fields', async () => {
    const setup = assistantSetup();
    const context = { source: 'chat' as const, conversationId: null };
    await expect(
      setup.tools.call(
        'propose_config_edit',
        { ...ADD_STAGING, edit: { op: 'signBundle', gate: 'www' } },
        context,
      ),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(
      setup.tools.call(
        'propose_config_edit',
        {
          ...ADD_STAGING,
          edit: { op: 'addEnvironment', environment: 'staging', gate: 'www' },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(setup.store.list()).toEqual([]);
  });

  it('has no tool that signs, seals, pins, deploys or touches keys', () => {
    const setup = assistantSetup();
    expect(setup.tools.all.map((tool) => tool.name).sort()).toEqual([
      'dry_run',
      'get_config',
      'get_config_schema',
      'get_project',
      'list_projects',
      'list_recipes',
      'propose_config_edit',
      'suggest_policy',
    ]);
    expect(
      setup.tools.all.every((tool) =>
        tool.effect === 'read' ? true : tool.name === 'propose_config_edit',
      ),
    ).toBe(true);
  });

  it('keeps the conversation as it was when the provider fails, without the key', async () => {
    const setup = assistantSetup([
      new AiProviderError('invalidKey', {
        status: 401,
        providerMessage: `bad key ${PLANTED_KEY}`,
      }),
    ]);
    const { id } = setup.chat.create();
    const result = await setup.chat.ask(id, {
      text: 'Hallo',
      projectId: null,
      locale: 'en',
    });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(PLANTED_KEY);
    expect(setup.chat.get(id)?.messages).toEqual([]);
  });

  it('stops after MAX_TOOL_STEPS', async () => {
    const setup = assistantSetup(
      Array.from({ length: MAX_TOOL_STEPS }, () =>
        turn('', [{ name: 'list_projects', input: {} }]),
      ),
    );
    const { id } = setup.chat.create();
    const result = await setup.chat.ask(id, {
      text: 'loop',
      projectId: null,
      locale: 'en',
    });
    expect(
      result.status === 'ok' && result.conversation.messages[1]?.cutShort,
    ).toBe(true);
  });

  it('says so without a provider', async () => {
    const setup = assistantSetup();
    setup.connection.register({ summary: () => null, open: async () => null });
    const { id } = setup.chat.create();
    expect(
      (await setup.chat.ask(id, { text: 'x', projectId: null, locale: 'en' }))
        .status,
    ).toBe('not_configured');
  });
});
