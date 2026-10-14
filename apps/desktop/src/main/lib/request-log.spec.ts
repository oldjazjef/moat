import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  logOutcome,
  MAX_LOG_FILE_BYTES,
  readLogFiles,
  type RequestLogApiResult,
} from './request-log';

describe('readLogFiles (FR-50, DT-12)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'moat-log-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads one or two regular files as text', () => {
    writeFileSync(join(dir, 'log.php'), 'a\n');
    writeFileSync(join(dir, 'logold.php'), 'b\n');
    expect(
      readLogFiles([join(dir, 'log.php'), join(dir, 'logold.php')]),
    ).toEqual({ texts: ['a\n', 'b\n'] });
  });

  it('refuses links, missing files, more than two files and no file', () => {
    writeFileSync(join(dir, 'log.php'), 'a\n');
    symlinkSync(join(dir, 'log.php'), join(dir, 'link.php'));
    expect(readLogFiles([join(dir, 'link.php')])).toEqual({
      refused: 'unreadable',
    });
    expect(readLogFiles([join(dir, 'missing.php')])).toEqual({
      refused: 'unreadable',
    });
    const file = join(dir, 'log.php');
    expect(readLogFiles([file, file, file])).toEqual({
      refused: 'unreadable',
    });
    expect(readLogFiles([])).toEqual({ refused: 'unreadable' });
  });

  it('refuses a file larger than a log, and bytes that are no UTF-8', () => {
    writeFileSync(join(dir, 'big.php'), Buffer.alloc(MAX_LOG_FILE_BYTES + 1));
    expect(readLogFiles([join(dir, 'big.php')])).toEqual({
      refused: 'too_large',
    });
    writeFileSync(join(dir, 'bin.php'), Buffer.from([0xff, 0xfe, 0x00]));
    expect(readLogFiles([join(dir, 'bin.php')])).toEqual({
      refused: 'unreadable',
    });
  });
});

describe('logOutcome', () => {
  it('passes the summary on and maps refusals', () => {
    const read: RequestLogApiResult = {
      status: 'read',
      log: {
        requests: 1,
        errors: 0,
        clients: 1,
        from: 1,
        to: 1,
        codes: [],
        routes: [],
        recent: [],
        skipped: 0,
      },
    };
    expect(logOutcome(read)).toEqual(read);
    expect(logOutcome({ status: 'refused', code: 'no_entries' })).toEqual({
      status: 'refused',
      code: 'no_entries',
    });
  });
});
