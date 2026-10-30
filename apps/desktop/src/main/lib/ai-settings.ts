import type {
  AiDialogInput,
  AiDialogTexts,
  AiDialogView,
  AiNotice,
} from '../../shared/ai-dialog';
import {
  type AssistantSettings,
  isModel,
  keyHintOf,
  MAX_KEY_LENGTH,
  normaliseBaseUrl,
} from './assistant';

/**
 * The AI provider window's logic (T-108): validates what was typed, keeps the token only as
 * keychain ciphertext and never hands it to the window again (it shows `…abcd`).
 */
export class AiSettingsSession {
  private notice: AiNotice | null = null;

  constructor(
    private readonly deps: {
      readonly texts: AiDialogTexts;
      readonly keychain: {
        readonly available: boolean;
        seal(secret: string): string;
      };
      stored(): AssistantSettings | null;
      save(settings: AssistantSettings | null): void;
    },
  ) {}

  view(): AiDialogView {
    const stored = this.deps.stored();
    return {
      texts: this.deps.texts,
      stored:
        stored === null
          ? null
          : {
              kind: stored.kind,
              baseUrl: stored.baseUrl,
              model: stored.model,
              keyHint: stored.keyHint,
            },
      canStoreKey: this.deps.keychain.available,
      notice: this.notice,
    };
  }

  save(input: AiDialogInput): AiDialogView {
    this.notice = this.check(input);
    return this.view();
  }

  forget(): AiDialogView {
    this.deps.save(null);
    this.notice = 'forgotten';
    return this.view();
  }

  private check(input: AiDialogInput): AiNotice {
    const url = normaliseBaseUrl(input.baseUrl);
    if (url.status !== 'ok') return 'url_invalid';
    const model = input.model.trim();
    if (!isModel(model)) return 'model_invalid';
    const key = input.key.trim();
    if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) return 'key_too_long';
    const stored = this.deps.stored();
    // A token of another provider must not travel to this one.
    const kept =
      stored !== null &&
      stored.kind === input.kind &&
      stored.baseUrl === url.url
        ? stored
        : null;
    let secret: string | null = kept?.secret ?? null;
    let keyHint: string | null = kept?.keyHint ?? null;
    if (key !== '') {
      if (!this.deps.keychain.available) return 'keychain_missing';
      secret = this.deps.keychain.seal(key);
      keyHint = keyHintOf(key);
    }
    const local = url.url !== '' && new URL(url.url).protocol === 'http:';
    if (secret === null && !local) return 'key_missing';
    this.deps.save({
      kind: input.kind,
      baseUrl: url.url,
      model,
      secret,
      keyHint: secret === null ? null : keyHint,
    });
    return 'saved';
  }
}
