import { basename } from 'node:path';

/** A project is called like its folder (`/home/me/sites/shop` → `shop`). */
export function projectName(folder: string): string {
  return basename(folder.replace(/[\\/]+$/, '')) || folder;
}
