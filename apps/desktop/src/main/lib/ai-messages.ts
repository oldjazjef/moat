import type { AiDialogTexts } from '../../shared/ai-dialog';
import type { DesktopLocale } from './messages';

/** The AI provider window's texts (T-108), in the page's language. */
export const AI_MESSAGES: Readonly<Record<DesktopLocale, AiDialogTexts>> = {
  'de-CH': {
    title: 'AI-Anbieter',
    intro:
      'Der Assistent schickt deine Fragen und das, was er liest (Projektnamen, moat.yaml, Gates ohne Secrets), an diesen Anbieter. Er sieht nie ein Secret, einen Schlüssel oder eine Passphrase. Das Token wird nur verschlüsselt im Schlüsselbund des Systems gespeichert.',
    kind: 'Anbieter',
    kinds: {
      anthropic: 'Anthropic (Claude)',
      openai_compatible: 'OpenAI-kompatibel (OpenAI, Ollama, LM Studio, …)',
    },
    baseUrl: 'Adresse',
    baseUrlHint:
      'Leer lassen für die Adresse des Anbieters. Sonst nur https, oder http zu diesem Rechner (z. B. http://localhost:11434/v1).',
    model: 'Modell',
    modelHint: 'Leer lassen für das Standardmodell des Anbieters.',
    key: 'API-Token',
    keyHint: 'Wird nie wieder angezeigt. Ein lokales Modell braucht keines.',
    keyStored: 'Gespeichert: {hint}. Leer lassen, um es zu behalten.',
    save: 'Speichern',
    forget: 'Anbieter entfernen',
    close: 'Schliessen',
    notices: {
      url_invalid:
        'Diese Adresse nimmt Moat nicht: nur https, oder http zu diesem Rechner, ohne Benutzer, Abfrage oder Anker.',
      model_invalid: 'Dieser Modellname enthält Zeichen, die Moat nicht nimmt.',
      key_too_long: 'Dieses Token ist zu lang oder enthält Leerzeichen.',
      key_missing: 'Für diesen Anbieter braucht es ein API-Token.',
      keychain_missing:
        'Dieses System hat keinen sicheren Schlüsselbund. Moat speichert das Token deshalb nicht.',
      saved: 'Gespeichert.',
      forgotten: 'Anbieter und Token entfernt.',
      failed: 'Das hat nicht geklappt.',
    },
  },
  en: {
    title: 'AI provider',
    intro:
      'The assistant sends your questions and what it reads (project names, moat.yaml, gates without secrets) to this provider. It never sees a secret, a key or a passphrase. The token is stored only encrypted in the system keychain.',
    kind: 'Provider',
    kinds: {
      anthropic: 'Anthropic (Claude)',
      openai_compatible: 'OpenAI-compatible (OpenAI, Ollama, LM Studio, …)',
    },
    baseUrl: 'Address',
    baseUrlHint:
      "Leave empty for the provider's address. Otherwise https only, or http to this computer (e.g. http://localhost:11434/v1).",
    model: 'Model',
    modelHint: "Leave empty for the provider's default model.",
    key: 'API token',
    keyHint: 'Never shown again. A local model needs none.',
    keyStored: 'Stored: {hint}. Leave empty to keep it.',
    save: 'Save',
    forget: 'Remove provider',
    close: 'Close',
    notices: {
      url_invalid:
        'Moat does not take this address: https only, or http to this computer, without user, query or fragment.',
      model_invalid: 'This model name contains characters Moat does not take.',
      key_too_long: 'This token is too long or contains spaces.',
      key_missing: 'This provider needs an API token.',
      keychain_missing:
        'This system has no secure keychain, so Moat does not store the token.',
      saved: 'Saved.',
      forgotten: 'Provider and token removed.',
      failed: 'That did not work.',
    },
  },
};
