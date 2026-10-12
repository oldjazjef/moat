import { Query } from '@nestjs/cqrs';
import type { ProjectSummary } from '../project.types';

/** Every project in the list, each read from its folder. */
export class ListProjectsQuery extends Query<readonly ProjectSummary[]> {}
