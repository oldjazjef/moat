import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * A PostgreSQL for the integration specs: `MOAT_TEST_POSTGRES_URL` when set (CI service), else a
 * throwaway cluster from the server binaries on this machine (trust auth on 127.0.0.1, a free
 * port, a temporary folder), else null and the specs skip. Run as root (containers), the cluster
 * runs as the `postgres` user, as PostgreSQL insists.
 */
export interface TestPostgres {
  /** A fresh, empty database per call. */
  database(): Promise<string>;
  stop(): Promise<void>;
}

const BIN_DIRS = ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin'];

export async function startTestPostgres(): Promise<TestPostgres | null> {
  const given = process.env['MOAT_TEST_POSTGRES_URL'];
  if (given !== undefined && given !== '') return withDatabases(given, null);
  const bin = BIN_DIRS.find((dir) => existsSync(join(dir, 'initdb')));
  if (bin === undefined) return null;
  const dir = mkdtempSync(join(tmpdir(), 'moat-pg-'));
  chmodSync(dir, 0o777);
  const asRoot = process.getuid?.() === 0;
  const run = (file: string, args: string[]) =>
    asRoot
      ? (['runuser', ['-u', 'postgres', '--', file, ...args]] as const)
      : ([file, args] as const);
  const data = join(dir, 'data');
  try {
    const [cmd, args] = run(join(bin, 'initdb'), [
      '-D',
      data,
      '-U',
      'postgres',
      '--auth=trust',
      '-E',
      'UTF8',
    ]);
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  const port = await freePort();
  const [cmd, args] = run(join(bin, 'postgres'), [
    '-D',
    data,
    '-p',
    String(port),
    '-k',
    dir,
    '-c',
    'listen_addresses=127.0.0.1',
    '-c',
    'fsync=off',
  ]);
  const server = spawn(cmd, args, { stdio: 'ignore' });
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const client = new Client({ connectionString: url });
      await client.connect();
      await client.end();
      return withDatabases(url, {
        server,
        dir,
        stop: () => {
          const [stopCmd, stopArgs] = run(join(bin, 'pg_ctl'), [
            'stop',
            '-D',
            data,
            '-m',
            'immediate',
          ]);
          execFileSync(stopCmd, stopArgs, { stdio: 'ignore' });
        },
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  server.kill('SIGINT');
  rmSync(dir, { recursive: true, force: true });
  return null;
}

function withDatabases(
  admin: string,
  owned: { server: ChildProcess; dir: string; stop: () => void } | null,
): TestPostgres {
  let count = 0;
  return {
    async database() {
      count += 1;
      const name = `moat_test_${process.pid}_${count}`;
      const client = new Client({ connectionString: admin });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name}`);
      await client.query(`CREATE DATABASE ${name}`);
      await client.end();
      const url = new URL(admin);
      url.pathname = `/${name}`;
      return url.toString();
    },
    async stop() {
      if (owned === null) return;
      const exited = new Promise<void>((resolve) => {
        if (owned.server.exitCode !== null) resolve();
        else owned.server.once('exit', () => resolve());
      });
      try {
        owned.stop();
      } catch {
        owned.server.kill('SIGKILL');
      }
      await exited;
      rmSync(owned.dir, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}
