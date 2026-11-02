/**
 * The main process's dialog windows load their static page from `moat-dialog://local/<file>`,
 * served from the packaged `dialogs/` folder. Not `file://`: the shipped app turns off the file
 * protocol's extra privileges (fuse `grantFileProtocolExtraPrivileges`), and with it a `file://`
 * page inside app.asar does not load — the windows opened blank. The scheme serves nothing but
 * the dialog pages and their stylesheet, by exact name.
 */
export const DIALOG_SCHEME = 'moat-dialog';
export const DIALOG_HOST = 'local';

const FILE = /^\/([a-z][a-z-]{0,62}\.(?:html|css))$/;

/** `dialogs/key-dialog.html` → `moat-dialog://local/key-dialog.html`. */
export function dialogUrl(page: string): string {
  const name = page.replace(/^dialogs\//, '');
  if (FILE.exec(`/${name}`) === null)
    throw new Error(`not a dialog page: ${page}`);
  return `${DIALOG_SCHEME}://${DIALOG_HOST}/${name}`;
}

/** The file a dialog URL asks for, or null for anything else (other host, path, extension). */
export function dialogFileOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${DIALOG_SCHEME}:` ||
    parsed.host !== DIALOG_HOST ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    return null;
  return FILE.exec(parsed.pathname)?.[1] ?? null;
}

export function dialogContentType(file: string): string {
  return file.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : 'text/html; charset=utf-8';
}
