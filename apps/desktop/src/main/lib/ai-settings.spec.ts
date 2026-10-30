import { describe, expect, it } from 'vitest';
import type { AiDialogTexts } from '../../shared/ai-dialog';
import type { AssistantSettings } from './assistant';
import { AiSettingsSession } from './ai-settings';

const KEY = 'sk-ant-TEST-ONLY-0123456789';

function setup(available = true) {
  let stored: AssistantSettings | null = null;
  const session = new AiSettingsSession({
    texts: {} as AiDialogTexts,
    keychain: { available, seal: (secret) => `sealed(${secret.length})` },
    stored: () => stored,
    save: (settings) => {
      stored = settings;
    },
  });
  return { session, stored: () => stored };
}

const input = { kind: 'anthropic' as const, baseUrl: '', model: '', key: KEY };

describe('AiSettingsSession (T-108)', () => {
  it('keeps the token only as keychain ciphertext and shows a hint', () => {
    const { session, stored } = setup();
    const view = session.save(input);
    expect(view.notice).toBe('saved');
    expect(JSON.stringify(stored())).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.stored?.keyHint).toBe('…6789');
  });

  it('keeps the stored token when the field is left empty, but not for another provider', () => {
    const { session, stored } = setup();
    session.save(input);
    session.save({ ...input, key: '', model: 'claude-opus-5-5' });
    expect(stored()?.secret).not.toBeNull();
    expect(
      session.save({ ...input, kind: 'openai_compatible', key: '' }).notice,
    ).toBe('key_missing');
  });

  it('refuses a token without a real keychain, and a bad address', () => {
    expect(setup(false).session.save(input).notice).toBe('keychain_missing');
    expect(
      setup().session.save({ ...input, baseUrl: 'http://example.com' }).notice,
    ).toBe('url_invalid');
  });

  it('takes a local model without a token', () => {
    const { session, stored } = setup(false);
    expect(
      session.save({
        kind: 'openai_compatible',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.1',
        key: '',
      }).notice,
    ).toBe('saved');
    expect(stored()?.secret).toBeNull();
  });

  it('forgets everything', () => {
    const { session, stored } = setup();
    session.save(input);
    expect(session.forget().notice).toBe('forgotten');
    expect(stored()).toBeNull();
  });
});
