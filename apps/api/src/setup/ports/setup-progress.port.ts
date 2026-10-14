import type { SetupProgress } from '../domain/setup';

/** The wizard's progress (as lazy-koins: an abstract class as the port, adapters in persistence/). */
export abstract class SetupProgressPort {
  /** EMPTY_PROGRESS when nothing was stored yet, or what was stored cannot be read. */
  abstract read(): SetupProgress;
  /** Throws when it cannot be written. */
  abstract write(progress: SetupProgress): void;
}
