import { createHash } from 'node:crypto';
import postgresRemove from '../../../prisma/postgresql/migrations/20261020120000_audit_gate_remove/migration.sql?raw';
import sqliteRemove from '../../../prisma/sqlite/migrations/20261020120000_audit_gate_remove/migration.sql?raw';
import postgresMail from '../../../prisma/postgresql/migrations/20261019120000_cloud_mail/migration.sql?raw';
import postgresGates from '../../../prisma/postgresql/migrations/20261018120000_cloud_gates/migration.sql?raw';
import postgresInit from '../../../prisma/postgresql/migrations/20261014120000_init/migration.sql?raw';
import postgresCloud from '../../../prisma/postgresql/migrations/20261015120000_cloud_accounts/migration.sql?raw';
import postgresAudit from '../../../prisma/postgresql/migrations/20261017120000_audit_log/migration.sql?raw';
import sqliteMail from '../../../prisma/sqlite/migrations/20261019120000_cloud_mail/migration.sql?raw';
import sqliteGates from '../../../prisma/sqlite/migrations/20261018120000_cloud_gates/migration.sql?raw';
import sqliteAudit from '../../../prisma/sqlite/migrations/20261017120000_audit_log/migration.sql?raw';
import sqliteInit from '../../../prisma/sqlite/migrations/20261014120000_init/migration.sql?raw';
import sqliteCloud from '../../../prisma/sqlite/migrations/20261015120000_cloud_accounts/migration.sql?raw';

/**
 * The migration histories of `apps/api/prisma/{sqlite,postgresql}/migrations`, bundled into the
 * API as text (webpack `asset/source`, Vite `?raw`) so Moat Desktop applies them without the
 * Prisma CLI and its schema-engine binary (as lazy-koins' desktop does). Add each new migration
 * folder here, in name order; `migrations.spec.ts` fails when a folder is missing.
 */
export type Dialect = 'sqlite' | 'postgresql';

export interface Migration {
  /** The folder name, e.g. `20261014120000_init`. */
  readonly name: string;
  readonly sql: string;
  /** SHA-256 hex of the file, as Prisma records it. */
  readonly checksum: string;
}

const migration = (name: string, sql: string): Migration => ({
  name,
  sql,
  checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
});

export const MIGRATIONS: Readonly<Record<Dialect, readonly Migration[]>> = {
  sqlite: [
    migration('20261014120000_init', sqliteInit),
    migration('20261015120000_cloud_accounts', sqliteCloud),
    migration('20261017120000_audit_log', sqliteAudit),
    migration('20261018120000_cloud_gates', sqliteGates),
    migration('20261019120000_cloud_mail', sqliteMail),
    migration('20261020120000_audit_gate_remove', sqliteRemove),
  ],
  postgresql: [
    migration('20261014120000_init', postgresInit),
    migration('20261015120000_cloud_accounts', postgresCloud),
    migration('20261017120000_audit_log', postgresAudit),
    migration('20261018120000_cloud_gates', postgresGates),
    migration('20261019120000_cloud_mail', postgresMail),
    migration('20261020120000_audit_gate_remove', postgresRemove),
  ],
};

/** The tables Moat's migrations create; any other table makes Moat refuse the database. */
export const MOAT_TABLES = [
  'history_entry',
  'sync_project',
  'sync_gate',
  'sync_secret',
  'sync_bundle',
  // Moat Cloud (AUTH_MODE=cloud, 20261015120000_cloud_accounts).
  'account',
  'account_totp',
  'recovery_code',
  'session',
  'organisation',
  'membership',
  'org_project',
  'rate_limit',
  // The audit log (20261017120000_audit_log).
  'audit_entry',
  // Cloud gates (20261018120000_cloud_gates).
  'cloud_config',
  'cloud_gate',
  'cloud_secret',
  'cloud_bundle',
  // E-mail: link tokens and pending invitations (20261019120000_cloud_mail).
  'account_token',
  'pending_invitation',
] as const;
export const MIGRATIONS_TABLE = '_prisma_migrations';
