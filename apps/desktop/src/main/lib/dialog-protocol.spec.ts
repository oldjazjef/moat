import { describe, expect, it } from 'vitest';
import { dialogFileOf, dialogUrl } from './dialog-protocol';

describe('dialog protocol (blank dialog windows in the packaged app)', () => {
  it('maps a dialog page to its URL and back', () => {
    const url = dialogUrl('dialogs/key-dialog.html');
    expect(url).toBe('moat-dialog://local/key-dialog.html');
    expect(dialogFileOf(url)).toBe('key-dialog.html');
    expect(dialogFileOf('moat-dialog://local/dialog.css')).toBe('dialog.css');
  });

  it('serves nothing but a dialog page or its stylesheet', () => {
    for (const url of [
      'moat-dialog://local/../main.js',
      'moat-dialog://local/%2e%2e/main.js',
      'moat-dialog://local/key-preload.js',
      'moat-dialog://other/key-dialog.html',
      'moat-dialog://local/key-dialog.html?x=1',
      'moat-dialog://local/sub/key-dialog.html',
      'app://moat/key-dialog.html',
      'not a url',
    ])
      expect(dialogFileOf(url), url).toBeNull();
    expect(() => dialogUrl('dialogs/../main.js')).toThrow();
  });
});

describe('dialog windows load through the dialog scheme', () => {
  it('never loads a dialog page over file:// (blank in the packaged app)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '../dialog-window.ts'), 'utf8');
    expect(source).not.toContain('pathToFileURL');
    expect(source).toContain('dialogUrl(options.page)');
  });
});
