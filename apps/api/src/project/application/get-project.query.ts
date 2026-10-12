import { Query } from '@nestjs/cqrs';
import type { ProjectView } from '../project.types';

/** The open project as the desktop shows it (read-only). */
export class GetProjectQuery extends Query<ProjectView> {}
