import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDatabaseUrl } from './database-url';
import { MIGRATIONS, MOAT_TABLES } from './migrations';

const PRISMA = resolve(__dirname, '../../../prisma');

/** The models of a schema without comments, generator and datasource. */
function models(provider: string): string {
  return readFileSync(join(PRISMA, provider, 'schema.prisma'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '')
    .join('\n')
    .replace(/generator client \{[^}]*\}/, '')
    .replace(/datasource db \{[^}]*\}/, '')
    .trim();
}

describe('database schemas (CLAUDE.md, Database)', () => {
  it('keeps the SQLite and PostgreSQL schemas structurally equal', () => {
    expect(models('sqlite')).toBe(models('postgresql'));
    expect(models('sqlite')).toContain('model HistoryEntry');
  });

  it('bundles every migration folder of both histories, in name order', () => {
    for (const provider of ['sqlite', 'postgresql'] as const) {
      const folders = readdirSync(join(PRISMA, provider, 'migrations'), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(MIGRATIONS[provider].map((m) => m.name)).toEqual(folders);
      for (const migration of MIGRATIONS[provider])
        expect(migration.sql).toBe(
          readFileSync(
            join(
              PRISMA,
              provider,
              'migrations',
              migration.name,
              'migration.sql',
            ),
            'utf8',
          ),
        );
    }
  });

  it('creates exactly the tables the migrator knows, with the hand-written CHECKs', () => {
    for (const provider of ['sqlite', 'postgresql'] as const) {
      const sql = MIGRATIONS[provider].map((m) => m.sql).join('\n');
      const created = [...sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map(
        (match) => match[1],
      );
      expect(created.sort()).toEqual([...MOAT_TABLES].sort());
      // Ciphertext only: the sealed-secret CHECK is part of both histories.
      expect(sql).toContain("'x25519-blake2b-xchacha20poly1305'");
      expect(sql).toMatch(/history_entry[^;]*(append-only|refuse_change)/);
    }
  });
});

describe('parseDatabaseUrl (TLS required but for this machine)', () => {
  it('accepts a PostgreSQL URL and never shows its password', () => {
    const parsed = parseDatabaseUrl(
      'postgresql://moat:s3cr%40t@db.example.ch:6543/team?sslmode=verify-full',
    );
    expect(parsed).toMatchObject({
      status: 'ok',
      label: 'postgresql://moat@db.example.ch:6543/team',
      config: {
        host: 'db.example.ch',
        port: 6543,
        database: 'team',
        user: 'moat',
        password: 's3cr@t',
        ssl: { rejectUnauthorized: true, servername: 'db.example.ch' },
      },
    });
  });

  it('requires verified TLS for every other host, whatever sslmode says', () => {
    expect(
      parseDatabaseUrl(
        'postgresql://moat:x@db.example.ch/team?sslmode=disable',
      ),
    ).toEqual({ status: 'refused', code: 'tls_required' });
    const prefer = parseDatabaseUrl(
      'postgres://moat:x@10.0.0.5/team?sslmode=prefer',
    );
    expect(prefer.status === 'ok' && prefer.config.ssl).toEqual({
      rejectUnauthorized: true,
      servername: undefined,
    });
    const plain = parseDatabaseUrl('postgresql://moat:x@db.example.ch/team');
    expect(plain.status === 'ok' && plain.config.ssl).toMatchObject({
      rejectUnauthorized: true,
    });
  });

  it('answers a malformed percent escape with url_invalid, never a thrown URIError', () => {
    for (const url of [
      'postgresql://moat:x@localhost/te%zzam',
      'postgresql://mo%zzat:x@localhost/team',
      'postgresql://moat:p%zz@localhost/team',
    ])
      expect(parseDatabaseUrl(url)).toEqual({
        status: 'refused',
        code: 'url_invalid',
      });
  });

  it('allows plain connections to this machine only', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const parsed = parseDatabaseUrl(`postgresql://moat:x@${host}:5432/moat`);
      expect(parsed.status === 'ok' && parsed.config.ssl).toBe(false);
    }
  });

  it('refuses anything else: other schemes, libpq file options, sockets, garbage', () => {
    for (const url of [
      'mysql://moat:x@db.example.ch/team',
      'postgresql://moat:x@db.example.ch/team?sslrootcert=/etc/passwd',
      'postgresql://moat:x@db.example.ch/team?host=/var/run/postgresql',
      'postgresql://moat:x@db.example.ch/team?sslmode=verify-full&sslmode=disable',
      'postgresql://moat:x@db.example.ch/',
      'postgresql://moat:x@db.example.ch/a/b',
      'postgresql://moat:x@/team',
      'postgresql://moat:x@db.example.ch/team#frag',
      'postgresql://moat:x@db.example.ch/team\n',
      'not a url',
      `postgresql://moat:${'x'.repeat(3000)}@db.example.ch/team`,
    ])
      expect(parseDatabaseUrl(url)).toEqual({
        status: 'refused',
        code: 'url_invalid',
      });
  });
});
