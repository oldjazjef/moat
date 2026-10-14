import type { StoragePort } from '@moat/core';

/** writeBundle found that version of the gate's bundle there already; nothing was written. */
export class BundleExistsError extends Error {
  override readonly name = 'BundleExistsError';
}

/** createConfig / writeGate found that file there already; nothing was written. */
export class FileExistsError extends Error {
  override readonly name = 'FileExistsError';
}

/** A project's files (DT-03): today always the project folder on disk. */
export abstract class ProjectFilesPort {
  /** The folder's files, or null when it can no longer be read. */
  abstract open(folder: string): StoragePort | null;

  /**
   * Replaces the project's moat.yaml with `text`, atomically. Throws when the folder or the file
   * cannot be written (gone, read-only, moat.yaml not a regular file).
   */
  abstract writeConfig(folder: string, text: string): void;

  /**
   * Writes a new signed bundle to `bundles/<gate>/<version>.json`. Never replaces a file: throws
   * BundleExistsError when that version is there already, another error when the folder cannot
   * be written.
   */
  abstract writeBundle(
    folder: string,
    gate: string,
    version: number,
    text: string,
  ): void;

  /**
   * Writes a sealed secret to `secrets/<gate>/<name>.json`, replacing the one there (atomically,
   * never through a symbolic link). Ciphertext only (SEC-31). Throws when it cannot be written.
   */
  abstract writeSecret(
    folder: string,
    gate: string,
    name: string,
    text: string,
  ): void;

  /**
   * Writes the moat.yaml of a new project. Never replaces one: throws FileExistsError when the
   * folder has a moat.yaml already, another error when it cannot be written.
   */
  abstract createConfig(folder: string, text: string): void;

  /**
   * Pins a gate: writes `gates/<gate>.json`. Never replaces one (another key under the same name
   * is a new gate, SEC-32): throws FileExistsError when it is there, another error when the
   * folder cannot be written.
   */
  abstract writeGate(folder: string, gate: string, text: string): void;
}
