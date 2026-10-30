import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { RouterTestingHarness } from '@angular/router/testing';
import type {
  Conversation,
  Proposal,
} from '../../../../core/api/assistant.types';
import { openPage, PROJECT } from '../../../../../testing/page-harness';
import { AssistantPage } from './assistant-page';

const ROUTES = [
  { path: 'app/assistant', component: AssistantPage },
  { path: 'app/settings', children: [] },
  { path: 'app/projects/:id/:tab', children: [] },
];
const CONFIGURED = {
  configured: true,
  provider: { kind: 'anthropic', baseUrl: '', model: '', hasKey: true },
};
const PROPOSAL: Proposal = {
  id: 'P'.repeat(22),
  source: 'chat',
  conversationId: 'C'.repeat(22),
  projectId: PROJECT.id,
  projectName: PROJECT.name,
  edit: { op: 'addEnvironment' },
  diff: [
    { kind: '…', lines: 4 },
    { kind: '+', text: 'environments:' },
    { kind: '+', text: '  staging: {}' },
  ],
  reason: 'A place to test.',
  createdAt: '2026-10-30T00:00:00Z',
  status: 'pending',
  error: null,
  decidedAt: null,
};
const EMPTY: Conversation = {
  id: 'C'.repeat(22),
  title: '',
  createdAt: '2026-10-30T00:00:00Z',
  updatedAt: '2026-10-30T00:00:00Z',
  messages: [],
  proposals: [],
};
const ANSWERED: Conversation = {
  ...EMPTY,
  title: 'Füge staging hinzu',
  messages: [
    {
      role: 'user',
      text: 'Füge staging hinzu',
      at: '',
      tools: [],
      proposalIds: [],
    },
    {
      role: 'assistant',
      text: 'Ich habe es vorgeschlagen.',
      at: '',
      tools: ['get_config', 'propose_config_edit'],
      proposalIds: [PROPOSAL.id],
    },
  ],
  proposals: [PROPOSAL],
};

async function settle(harness: RouterTestingHarness): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve));
    harness.detectChanges();
  }
}

describe('AssistantPage (T-107)', () => {
  afterEach(() => {
    delete window.moatDesktop;
  });

  it('asks to set up a provider in the main process when there is none', async () => {
    const openProvider = vi.fn().mockResolvedValue(undefined);
    window.moatDesktop = { assistant: { openProvider } } as never;
    const { el, harness } = await openPage('/app/assistant', ROUTES, {
      '/api/assistant/status': { configured: false, provider: null },
      '/api/assistant/conversations': [],
      '/api/assistant/proposals': [],
      '/api/projects': [],
    });
    expect(el.querySelector('[data-assistant-setup]')).not.toBeNull();
    expect(el.querySelector('[data-assistant-question]')).toBeNull();
    (
      el.querySelector('[data-assistant-provider]') as HTMLButtonElement
    ).click();
    await settle(harness);
    expect(openProvider).toHaveBeenCalledWith('de-CH');
  });

  it('shows a proposal with its change and applies it only on «Ausführen»', async () => {
    const { el, harness } = await openPage('/app/assistant', ROUTES, {
      '/api/assistant/status': CONFIGURED,
      '/api/assistant/conversations': [],
      '/api/assistant/proposals': [],
      '/api/projects': [],
    });
    const http = TestBed.inject(HttpTestingController);
    const question = el.querySelector(
      '[data-assistant-question]',
    ) as HTMLTextAreaElement;
    question.value = 'Füge staging hinzu';
    question.dispatchEvent(new Event('input'));
    harness.detectChanges();
    (el.querySelector('[data-assistant-send]') as HTMLButtonElement).click();
    await settle(harness);
    http
      .expectOne({ method: 'POST', url: '/api/assistant/conversations' })
      .flush(EMPTY);
    await settle(harness);
    for (const r of http.match('/api/assistant/conversations')) r.flush([]);
    const ask = http.expectOne({
      method: 'POST',
      url: `/api/assistant/conversations/${EMPTY.id}/messages`,
    });
    expect(ask.request.body).toEqual({
      text: 'Füge staging hinzu',
      locale: 'de-CH',
    });
    ask.flush(ANSWERED);
    await settle(harness);
    for (const r of http.match(() => true))
      r.flush(r.request.url.endsWith('proposals') ? [PROPOSAL] : []);
    await settle(harness);

    const card = el.querySelector('[data-proposal]');
    expect(card?.getAttribute('data-status')).toBe('pending');
    expect(card?.querySelector('[data-proposal-diff]')?.textContent).toContain(
      'staging',
    );
    expect(el.querySelector('[data-message-tools]')?.textContent).toContain(
      'Vorschlag',
    );
    (
      card?.querySelector('[data-proposal-confirm]') as HTMLButtonElement
    ).click();
    await settle(harness);
    http
      .expectOne({
        method: 'POST',
        url: `/api/assistant/proposals/${PROPOSAL.id}/confirm`,
      })
      .flush({ ...PROPOSAL, status: 'done' });
    await settle(harness);
    for (const r of http.match(() => true))
      r.flush(
        r.request.url.endsWith('proposals')
          ? [{ ...PROPOSAL, status: 'done' }]
          : { ...ANSWERED, proposals: [{ ...PROPOSAL, status: 'done' }] },
      );
    await settle(harness);
    expect(
      el.querySelector('[data-proposal]')?.getAttribute('data-status'),
    ).toBe('done');
  });

  it('names the provider error without hiding the conversation', async () => {
    const { el, harness } = await openPage('/app/assistant', ROUTES, {
      '/api/assistant/status': CONFIGURED,
      '/api/assistant/conversations': [],
      '/api/assistant/proposals': [],
      '/api/projects': [],
    });
    const http = TestBed.inject(HttpTestingController);
    const question = el.querySelector(
      '[data-assistant-question]',
    ) as HTMLTextAreaElement;
    question.value = 'Hallo';
    question.dispatchEvent(new Event('input'));
    harness.detectChanges();
    (el.querySelector('[data-assistant-send]') as HTMLButtonElement).click();
    await settle(harness);
    http
      .expectOne({ method: 'POST', url: '/api/assistant/conversations' })
      .flush(EMPTY);
    await settle(harness);
    for (const r of http.match('/api/assistant/conversations')) r.flush([]);
    http
      .expectOne({
        method: 'POST',
        url: `/api/assistant/conversations/${EMPTY.id}/messages`,
      })
      .flush(
        {
          error: 'invalidKey',
          details: { status: 401, providerMessage: 'bad key' },
        },
        { status: 502, statusText: 'Bad Gateway' },
      );
    await settle(harness);
    const error = el.querySelector('[data-assistant-error]');
    expect(error?.textContent).toContain('Token abgelehnt');
    expect(error?.textContent).toContain('HTTP 401');
    // The question stays in the field to be sent again.
    expect(question.value).toBe('Hallo');
  });
});
