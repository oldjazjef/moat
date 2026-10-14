import { EMPTY_PROGRESS, type SetupProgress } from '../domain/setup';
import { SetupProgressPort } from '../ports/setup-progress.port';

export class InMemorySetupProgress extends SetupProgressPort {
  progress: SetupProgress = EMPTY_PROGRESS;
  writable = true;

  read(): SetupProgress {
    return this.progress;
  }

  write(progress: SetupProgress): void {
    if (!this.writable) throw new Error('not writable');
    this.progress = progress;
  }
}
