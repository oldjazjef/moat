import { createHash } from 'node:crypto';

/** SHA-256 (hex) of moat.yaml's text: the version an edit is based on (ProjectView.configHash). */
export function configHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
