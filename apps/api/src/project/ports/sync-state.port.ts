/**
 * What a project and its database last agreed on (DT-13): the SHA-256 of moat.yaml after the last
 * successful sync, per project and database key. A change on both sides since then is a conflict.
 */
export abstract class SyncStatePort {
  abstract base(projectId: string, key: string): string | null;
  abstract setBase(projectId: string, key: string, configHash: string): void;
}
