import { inflateRawSync } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import {
  ImportPlanError,
  packageBundleName,
  planImport,
  type ImportPlanErrorCode,
  type ImportSource,
  type Inflate,
  type PackageEntry,
  type PlanSigner,
} from '@moat/core';
import {
  BundleExistsError,
  ProjectFilesPort,
} from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';

/**
 * What the main process read after its own file or folder dialog (FR-45): the bytes of the chosen
 * file (a bundle or a package ZIP, told apart by the ZIP signature), or a package folder's
 * entries and a way to read one of them. Never a path: the API does not open anything itself.
 */
export type ImportInput =
  | { readonly kind: 'file'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'folder';
      readonly entries: readonly PackageEntry[];
      /** The bytes of a regular file in the folder, null when it cannot be read. */
      readonly read: (name: string) => Uint8Array | 'too_large' | null;
    };

export type BundleImportResult =
  | { readonly status: 'imported'; readonly version: number }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: ImportPlanErrorCode | 'unreadable';
    }
  | { readonly status: 'not_writable' };

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** Deflate in a package ZIP, never more than the entry claims (zlib stops there). */
const inflate: Inflate = (data, maxBytes) =>
  new Uint8Array(
    inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) }),
  );

/**
 * Manual import of a bundle (FR-45, DT-17, T-50), in-process for Moat Desktop's main process
 * only: what to import is chosen in its own dialog (DT-08). Core checks the bundle as the gate
 * would, against the person's key; only the bundle's exact bytes are written, as
 * `bundles/<gate>/<version>.json` (never over an existing file).
 */
@Injectable()
export class BundleImportService {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async import(
    id: string,
    gate: string,
    signer: PlanSigner,
    input: ImportInput,
  ): Promise<BundleImportResult> {
    if (!PROJECT_ID.test(id)) return { status: 'not_found' };
    const entry = this.registry.get(id);
    const storage = entry === null ? null : this.files.open(entry.folder);
    if (entry === null || storage === null) return { status: 'not_found' };
    try {
      const source = sourceOf(input);
      if (source === 'unreadable' || source === 'too_large')
        return { status: 'refused', code: source };
      const plan = await planImport(storage, gate, signer, source);
      try {
        this.files.writeBundle(
          entry.folder,
          plan.gate,
          plan.version,
          plan.bundle,
        );
      } catch (error) {
        // That version appeared meanwhile (another window, the CLI): not newer any more.
        if (error instanceof BundleExistsError)
          return { status: 'refused', code: 'version_not_newer' };
        return { status: 'not_writable' };
      }
      return { status: 'imported', version: plan.version };
    } catch (error) {
      if (error instanceof ImportPlanError)
        return { status: 'refused', code: error.code };
      throw error;
    }
  }
}

function sourceOf(
  input: ImportInput,
): ImportSource | 'unreadable' | 'too_large' {
  if (input.kind === 'file') {
    const zip = ZIP_SIGNATURE.every((byte, i) => input.bytes[i] === byte);
    return zip
      ? { kind: 'zip', bytes: input.bytes, inflate }
      : { kind: 'bundle', bytes: input.bytes };
  }
  // Throws package_invalid for anything but a package's files.
  const name = packageBundleName(input.entries);
  const bytes = input.read(name);
  if (bytes === null) return 'unreadable';
  if (bytes === 'too_large') return 'too_large';
  return { kind: 'package', name, bytes };
}
