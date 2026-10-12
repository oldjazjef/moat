import { Query } from '@nestjs/cqrs';
import type { ProjectView } from '../project.types';

/** One project as the desktop shows it (read-only); null when it is not in the list. */
export class GetProjectQuery extends Query<ProjectView | null> {
  constructor(readonly id: string) {
    super();
  }
}
