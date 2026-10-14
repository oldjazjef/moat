import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DeployRefusal, DeployResult } from '../../shared/bridge';

/** The API's in-process answer (apps/api/src/project/application/deploy-package.service.ts). */
export interface DeployPackage {
  readonly project: string;
  readonly gate: string;
  readonly gateId: string;
  readonly version: number;
  readonly locked: boolean;
  readonly bundle: string;
  readonly bundleSha256: string;
  readonly policy: string;
}

export type PrepareDeployResult =
  | { readonly status: 'ready'; readonly package: DeployPackage }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: Exclude<DeployRefusal, 'key_missing'>;
    };

export interface DeployTexts {
  /** The instructions' file name (`LIESMICH.txt`, `README.txt`). */
  readonly readmeName: string;
  readonly readme: (pkg: DeployPackage, bundleFile: string) => string;
}

export interface DeployFile {
  /** `moat-<gate>-v<version>/<file>` */
  readonly name: string;
  readonly data: Uint8Array;
}

/** `moat-www-v3`: the folder the package's files sit in, in the ZIP and on disk. */
export function packageName(pkg: DeployPackage): string {
  return `moat-${pkg.gate}-v${pkg.version}`;
}

/**
 * The package (DT-05): the bundle exactly as signed, the policy for it, and how to install both.
 * Nothing else: no key file, no gate code (gate updates never travel with config, SEC-22), no
 * secret value (the bundle carries sealed ones only, SEC-31).
 */
export function deployFiles(
  pkg: DeployPackage,
  texts: DeployTexts,
): DeployFile[] {
  const folder = packageName(pkg);
  const bundleFile = `bundle-v${pkg.version}.json`;
  const encode = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
  return [
    { name: `${folder}/${bundleFile}`, data: encode(pkg.bundle) },
    { name: `${folder}/policy.json`, data: encode(pkg.policy) },
    {
      name: `${folder}/${texts.readmeName}`,
      data: encode(texts.readme(pkg, bundleFile)),
    },
  ];
}

export type WriteResult = Extract<
  DeployResult,
  { status: 'exists' | 'not_writable' }
> | null;

/**
 * Writes the package as a new folder inside `parent` (chosen in the main process's dialog).
 * Never replaces anything: an existing folder of that name gives `exists`. A folder it created
 * and could not fill is removed again.
 */
export function writeDeployFolder(
  parent: string,
  files: readonly DeployFile[],
): WriteResult {
  const folder = files[0]?.name.split('/')[0];
  if (folder === undefined) return { status: 'not_writable' };
  const target = join(parent, folder);
  try {
    mkdirSync(target);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? { status: 'exists' }
      : { status: 'not_writable' };
  }
  try {
    for (const file of files)
      writeFileSync(join(parent, file.name), file.data, { flag: 'wx' });
    return null;
  } catch {
    // Created above, so it is ours: never leave half a package behind.
    rmSync(target, { recursive: true, force: true });
    return { status: 'not_writable' };
  }
}

/**
 * Saves the ZIP at `path` (chosen in the main process's save dialog, which asked before replacing
 * a file): written next to it first and renamed, so a failed write never leaves half a ZIP.
 */
export function writeDeployZip(path: string, zip: Uint8Array): WriteResult {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temp, zip, { flag: 'wx' });
    renameSync(temp, path);
    return null;
  } catch {
    rmSync(temp, { force: true });
    return { status: 'not_writable' };
  }
}
