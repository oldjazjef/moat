/**
 * The contract between the main process and the AI provider window (T-108). Provider, address,
 * model and token are typed only in this window, never in the app's page; the main process keeps
 * the token only as keychain ciphertext (DT-04). Like the other dialogs it has no page script:
 * the preload renders with `textContent` only.
 */
export const AI_IPC = {
  /** () → AiDialogView */
  view: 'moat:ai-dialog:view',
  /** (AiDialogInput) → AiDialogView */
  save: 'moat:ai-dialog:save',
  /** () → AiDialogView: removes the provider and its token. */
  forget: 'moat:ai-dialog:forget',
  /** () → void */
  close: 'moat:ai-dialog:close',
} as const;

export type AiDialogKind = 'anthropic' | 'openai_compatible';

export interface AiDialogInput {
  readonly kind: AiDialogKind;
  readonly baseUrl: string;
  readonly model: string;
  /** Empty: keep the stored token. */
  readonly key: string;
}

export const AI_NOTICES = [
  'url_invalid',
  'model_invalid',
  'key_too_long',
  'key_missing',
  'keychain_missing',
  'saved',
  'forgotten',
  'failed',
] as const;
export type AiNotice = (typeof AI_NOTICES)[number];

export interface AiDialogView {
  readonly texts: AiDialogTexts;
  readonly stored: {
    readonly kind: AiDialogKind;
    readonly baseUrl: string;
    readonly model: string;
    /** `…abcd`, or null without a token. */
    readonly keyHint: string | null;
  } | null;
  /** Only with a real OS keychain (DT-04) can a token be kept. */
  readonly canStoreKey: boolean;
  readonly notice: AiNotice | null;
}

export interface AiDialogTexts {
  readonly title: string;
  readonly intro: string;
  readonly kind: string;
  readonly kinds: Readonly<Record<AiDialogKind, string>>;
  readonly baseUrl: string;
  readonly baseUrlHint: string;
  readonly model: string;
  readonly modelHint: string;
  readonly key: string;
  readonly keyHint: string;
  readonly keyStored: string;
  readonly save: string;
  readonly forget: string;
  readonly close: string;
  readonly notices: Readonly<Record<AiNotice, string>>;
}
