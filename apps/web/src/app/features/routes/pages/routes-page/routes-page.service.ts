import { computed, inject, Injectable, signal } from '@angular/core';
import type {
  CompiledRoute,
  CompiledUpstream,
} from '../../../../core/api/project.types';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { ProjectResource } from '../../../../core/project/project-resource.service';
import { durationParts, sizeParts } from '../../../../shared/format/duration';

export interface RouteRow {
  readonly name: string;
  readonly route: CompiledRoute;
  /** The upstream's origin, '' when the route names an unknown one (the config is then invalid). */
  readonly target: string;
  readonly window: ReturnType<typeof durationParts> | null;
  readonly maxBody: ReturnType<typeof sizeParts>;
}

export interface UpstreamRow {
  readonly name: string;
  readonly upstream: CompiledUpstream;
  readonly timeout: ReturnType<typeof durationParts>;
}

/**
 * Routes (FR-10 ff.): every route of the compiled moat.yaml as the gate enforces it — method and
 * exact path, the upstream it forwards to, browser origins (FR-15), rate limit (FR-30), body
 * limit — and the upstreams with the secret each one uses (by name only). Routes are added,
 * changed, switched off and removed here (ProjectEdits); upstreams still in moat.yaml.
 */
@Injectable()
export class RoutesPageService {
  readonly resource = inject(ProjectResource);
  readonly edits = inject(ProjectEdits);

  /** The open form: «Neue Route» (`null`) or the route being changed; undefined = closed. */
  readonly editing = signal<RouteRow | null | undefined>(undefined);
  /** «Löschen» asks once: the route waiting for the second click. */
  readonly confirmingRemove = signal<string | null>(null);

  private readonly config = computed(() => {
    const config = this.resource.config();
    return config?.status === 'valid' ? config.config : null;
  });

  /** The config could not be compiled (or is missing): the overview says why. */
  readonly unusable = computed(
    () => this.resource.project() !== null && this.config() === null,
  );

  readonly routes = computed<readonly RouteRow[]>(() => {
    const config = this.config();
    if (config === null) return [];
    return Object.entries(config.routes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, route]) => ({
        name,
        route,
        target: `${config.upstreams[route.upstream]?.origin ?? ''}${route.upstreamPath}`,
        window: route.rateLimit
          ? durationParts(route.rateLimit.windowSeconds)
          : null,
        maxBody: sizeParts(route.maxBodyBytes),
      }));
  });

  readonly upstreams = computed<readonly UpstreamRow[]>(() => {
    const config = this.config();
    if (config === null) return [];
    return Object.entries(config.upstreams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, upstream]) => ({
        name,
        upstream,
        timeout: durationParts(upstream.timeoutMs / 1000),
      }));
  });

  readonly upstreamNames = computed(() =>
    this.upstreams().map((row) => row.name),
  );

  open(row: RouteRow | null): void {
    this.edits.dismiss();
    this.confirmingRemove.set(null);
    this.editing.set(row);
  }

  close(): void {
    this.editing.set(undefined);
  }

  setEnabled(row: RouteRow, enabled: boolean): Promise<boolean> {
    return this.edits.run({
      op: enabled ? 'enableRoute' : 'disableRoute',
      route: row.name,
    });
  }

  async remove(row: RouteRow): Promise<void> {
    if (this.confirmingRemove() !== row.name) {
      this.confirmingRemove.set(row.name);
      return;
    }
    this.confirmingRemove.set(null);
    if (this.editing()?.name === row.name) this.close();
    await this.edits.run({ op: 'removeRoute', route: row.name });
  }
}
