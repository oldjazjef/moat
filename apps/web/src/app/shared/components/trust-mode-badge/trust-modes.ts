import type { TrustMode } from '../../../core/api/project.types';

/**
 * The trust modes as the product names them (ANFORDERUNGEN §2.9, SEC-58): the label, the short
 * description and the "Wenn Moat Cloud gehackt wird …" sentence — only these texts, word for word
 * (`trust-modes.spec.ts` compares them with §2.9). Moat Desktop knows "Signiert" and
 * "Signiert mit Passkey" (a gate the person set to sign with the passkey); "Bequem" and "Eigene
 * Freigabe" come with the Cloud.
 */
export const TRUST_MODES: readonly TrustMode[] = ['signed', 'passkey'];

/** How strong the guarantee is: the badge's colour (`mt-trust-strong` / `mt-trust-weak`). */
export const TRUST_STRENGTH: Readonly<Record<TrustMode, 'strong' | 'weak'>> = {
  signed: 'strong',
  passkey: 'strong',
};

export const trustKeys = {
  label: (mode: TrustMode) => `trust.modes.${mode}.label`,
  short: (mode: TrustMode) => `trust.modes.${mode}.short`,
  ifHacked: (mode: TrustMode) => `trust.modes.${mode}.ifHacked`,
};

/** Every key built at runtime (listed in `i18n-keys.spec.ts`). */
export function allTrustKeys(): string[] {
  return TRUST_MODES.flatMap((mode) => [
    trustKeys.label(mode),
    trustKeys.short(mode),
    trustKeys.ifHacked(mode),
  ]);
}
