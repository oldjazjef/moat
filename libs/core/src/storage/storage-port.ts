/**
 * Where a project lives (DT-03): the project folder by default, later SQLite or an external
 * database. The core never touches the file system itself; the caller hands in a port that reads
 * paths relative to the project root (`moat.yaml`, `gates/<gate>.json`, …).
 *
 * Read-only for now: the desktop shows a project, the CLI writes it.
 */
export interface StoragePort {
  /** The UTF-8 text of a file, or null when it does not exist. */
  read(path: string): string | null;
  /** The entry names directly inside a folder, [] when it does not exist. */
  list(dir: string): readonly string[];
}
