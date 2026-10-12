import sodiumModule from 'libsodium-wrappers-sumo';

export type Sodium = typeof sodiumModule;

/** The one libsodium instance (CLAUDE.md: libsodium only, no other crypto library). */
export async function sodium(): Promise<Sodium> {
  await sodiumModule.ready;
  return sodiumModule;
}
