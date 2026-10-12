/**
 * Locales the app ships (as lazy-koins). Adding one means adding `public/i18n/<code>.json` (every
 * key of de-CH.json — `i18n-keys.spec.ts` checks), the code here and its Angular locale data
 * (`i18n.config.ts`).
 */
export const SUPPORTED_LOCALES = ['de-CH', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'de-CH';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/** The browser's language — German (any de-*) → de-CH, everything else English. */
export function browserLocale(
  languages: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages?.length
      ? navigator.languages
      : [navigator.language],
): SupportedLocale {
  const first = languages.find((language) => !!language) ?? DEFAULT_LOCALE;
  return first.toLowerCase().startsWith('de') ? 'de-CH' : 'en';
}

// A template literal: i18n-keys.spec.ts reads quoted dotted literals as translation keys.
export const LOCALE_STORAGE_KEY = `mt.locale`;

/** The language at start: the one used last on this device, else the browser's. */
export function initialLocale(): SupportedLocale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSupportedLocale(stored)) return stored;
  } catch {
    // Storage blocked: the browser's language.
  }
  return browserLocale();
}
