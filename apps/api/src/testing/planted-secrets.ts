/**
 * Values that look like real secrets, planted where a careless change would pick them up (as
 * lazy-koins): tests assert they never show up in a database, a log, an error or a response.
 * TEST ONLY — not real credentials.
 */
export const PLANTED_SECRETS = [
  'sk-PLANTED-0123456789abcdefghijklmnop',
  'pat-na1-PLANTED-00000000-0000-0000-0000-000000000000',
  'correct horse battery PLANTED',
] as const;

/** Every planted value found in `text`. */
export function plantedIn(text: string): string[] {
  return PLANTED_SECRETS.filter((secret) => text.includes(secret));
}
