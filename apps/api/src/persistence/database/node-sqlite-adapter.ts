import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ArgType,
  type ColumnType,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlDriverAdapterFactory,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
} from '@prisma/driver-adapter-utils';

/**
 * A Prisma 7 driver adapter on Node's built-in SQLite (`node:sqlite`, in Node 22 and Electron 42),
 * so Moat Desktop keeps no native module (CLAUDE.md, Desktop). Modelled on Prisma's own
 * `@prisma/adapter-better-sqlite3` 7.10.0 — `node:sqlite`'s DatabaseSync has the same synchronous
 * shape — and kept to what Moat's schema uses: TEXT and INTEGER columns, one connection, one
 * transaction at a time.
 *
 * Prisma sends BEGIN/COMMIT itself (`usePhantomQuery: false`); the adapter only serialises
 * transactions so two never interleave on the one connection.
 */
export const NODE_SQLITE_ADAPTER = '@moat/adapter-node-sqlite';

export class PrismaNodeSqlite implements SqlDriverAdapterFactory {
  readonly provider = 'sqlite' as const;
  readonly adapterName = NODE_SQLITE_ADAPTER;

  /** `file`: an absolute path, or `:memory:` (tests). */
  constructor(private readonly file: string) {}

  connect(): Promise<SqlDriverAdapter> {
    const db = new DatabaseSync(this.file);
    // One writer, readers never blocked; wait for a lock instead of failing (CLAUDE.md, Database).
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    return Promise.resolve(new NodeSqliteAdapter(db));
  }
}

class NodeSqliteQueryable {
  readonly provider = 'sqlite' as const;
  readonly adapterName = NODE_SQLITE_ADAPTER;

  constructor(protected readonly db: DatabaseSync) {}

  queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    try {
      const statement = this.db.prepare(query.sql);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const args = query.args.map((arg, i) => toSqlite(arg, query.argTypes[i]));
      const columns = statement.columns();
      if (columns.length === 0) {
        statement.run(...args);
        return Promise.resolve({ columnNames: [], columnTypes: [], rows: [] });
      }
      const rows = statement.all(...args) as unknown as unknown[][];
      const columnTypes = columnTypesOf(
        columns.map((column) => column.type),
        rows,
      );
      return Promise.resolve({
        columnNames: columns.map((column) => column.name),
        columnTypes,
        rows: rows.map((row) => fromSqlite(row, columnTypes)),
      });
    } catch (error) {
      throw driverError(error);
    }
  }

  executeRaw(query: SqlQuery): Promise<number> {
    try {
      const statement = this.db.prepare(query.sql);
      const args = query.args.map((arg, i) => toSqlite(arg, query.argTypes[i]));
      return Promise.resolve(Number(statement.run(...args).changes));
    } catch (error) {
      throw driverError(error);
    }
  }
}

class NodeSqliteTransaction extends NodeSqliteQueryable implements Transaction {
  readonly options = { usePhantomQuery: false };

  constructor(
    db: DatabaseSync,
    private readonly release: () => void,
  ) {
    super(db);
  }

  commit(): Promise<void> {
    this.release();
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.release();
    return Promise.resolve();
  }
}

class NodeSqliteAdapter
  extends NodeSqliteQueryable
  implements SqlDriverAdapter
{
  /** The tail of the queue of transactions: each waits for the one before. */
  private queue: Promise<void> = Promise.resolve();

  executeScript(script: string): Promise<void> {
    try {
      this.db.exec(script);
    } catch (error) {
      throw driverError(error);
    }
    return Promise.resolve();
  }

  async startTransaction(
    isolationLevel?: IsolationLevel,
  ): Promise<Transaction> {
    if (isolationLevel !== undefined && isolationLevel !== 'SERIALIZABLE')
      throw new DriverAdapterError({
        kind: 'InvalidIsolationLevel',
        level: isolationLevel,
      });
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      let done = false;
      release = () => {
        if (done) return;
        done = true;
        resolve();
      };
    });
    await previous;
    try {
      this.db.exec('BEGIN');
    } catch (error) {
      release();
      throw driverError(error);
    }
    return new NodeSqliteTransaction(this.db, release);
  }

  dispose(): Promise<void> {
    if (this.db.isOpen) this.db.close();
    return Promise.resolve();
  }
}

/** What Prisma hands in → what node:sqlite binds (as the better-sqlite3 adapter's mapArg). */
function toSqlite(arg: unknown, type: ArgType | undefined): SQLInputValue {
  if (arg === null || arg === undefined) return null;
  const scalar = type?.scalarType;
  if (typeof arg === 'string' && scalar === 'int')
    return Number.parseInt(arg, 10);
  if (typeof arg === 'string' && (scalar === 'float' || scalar === 'decimal'))
    return Number.parseFloat(arg);
  if (typeof arg === 'string' && scalar === 'bigint') return BigInt(arg);
  if (typeof arg === 'boolean') return arg ? 1 : 0;
  if (arg instanceof Date) return arg.toISOString().replace('Z', '+00:00');
  if (typeof arg === 'string' && scalar === 'datetime')
    return new Date(arg).toISOString().replace('Z', '+00:00');
  if (typeof arg === 'string' && scalar === 'bytes')
    return Buffer.from(arg, 'base64');
  if (
    typeof arg === 'string' ||
    typeof arg === 'number' ||
    typeof arg === 'bigint' ||
    arg instanceof Uint8Array
  )
    return arg;
  throw new DriverAdapterError({
    kind: 'sqlite',
    extendedCode: 20,
    message: 'unsupported argument type',
  });
}

/** Declared column types → Prisma's, inferring from the values where none is declared. */
function columnTypesOf(
  declared: readonly (string | null)[],
  rows: readonly unknown[][],
): ColumnType[] {
  return declared.map((type, index) => {
    const mapped = mapDeclaredType(type);
    if (mapped !== null) return mapped;
    for (const row of rows) {
      const value = row[index];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') return ColumnTypeEnum.Text;
      if (typeof value === 'bigint') return ColumnTypeEnum.Int64;
      if (typeof value === 'number') return ColumnTypeEnum.UnknownNumber;
      if (value instanceof Uint8Array) return ColumnTypeEnum.Bytes;
    }
    return ColumnTypeEnum.Int32;
  });
}

function mapDeclaredType(type: string | null): ColumnType | null {
  switch ((type ?? '').toUpperCase()) {
    case 'TEXT':
    case 'CLOB':
    case 'VARCHAR':
      return ColumnTypeEnum.Text;
    case 'INT':
    case 'INTEGER':
    case 'SMALLINT':
    case 'TINYINT':
    case 'MEDIUMINT':
      return ColumnTypeEnum.Int32;
    case 'BIGINT':
    case 'INT8':
      return ColumnTypeEnum.Int64;
    case 'REAL':
    case 'DOUBLE':
    case 'NUMERIC':
      return ColumnTypeEnum.Double;
    case 'FLOAT':
      return ColumnTypeEnum.Float;
    case 'DECIMAL':
      return ColumnTypeEnum.Numeric;
    case 'BOOLEAN':
      return ColumnTypeEnum.Boolean;
    case 'DATETIME':
    case 'TIMESTAMP':
      return ColumnTypeEnum.DateTime;
    case 'DATE':
      return ColumnTypeEnum.Date;
    case 'TIME':
      return ColumnTypeEnum.Time;
    case 'BLOB':
      return ColumnTypeEnum.Bytes;
    default:
      return null;
  }
}

/** Big integers as numbers where they fit (as the better-sqlite3 adapter's mapRow). */
function fromSqlite(row: readonly unknown[], types: ColumnType[]): unknown[] {
  return row.map((value, index) => {
    const type = types[index];
    if (
      typeof value === 'number' &&
      (type === ColumnTypeEnum.Int32 || type === ColumnTypeEnum.Int64) &&
      !Number.isInteger(value)
    )
      return Math.trunc(value);
    if (
      (typeof value === 'number' || typeof value === 'bigint') &&
      type === ColumnTypeEnum.DateTime
    )
      return new Date(Number(value)).toISOString();
    if (typeof value === 'bigint') {
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    return value;
  });
}

/** node:sqlite's errors → Prisma's error kinds (unique and foreign keys; the rest generic). */
function driverError(error: unknown): DriverAdapterError {
  if (error instanceof DriverAdapterError) return error;
  const message = error instanceof Error ? error.message : 'sqlite error';
  const code =
    typeof (error as { errcode?: unknown }).errcode === 'number'
      ? (error as { errcode: number }).errcode
      : 1;
  // SQLITE_CONSTRAINT_PRIMARYKEY (1555) and SQLITE_CONSTRAINT_UNIQUE (2067).
  if (code === 1555 || code === 2067) {
    const columns = message.split('constraint failed: ').at(1)?.split(', ');
    return new DriverAdapterError({
      kind: 'UniqueConstraintViolation',
      constraint:
        columns === undefined
          ? undefined
          : { fields: columns.map((column) => column.split('.').pop() ?? '') },
      originalCode: String(code),
      originalMessage: message,
    });
  }
  // SQLITE_CONSTRAINT_FOREIGNKEY (787).
  if (code === 787)
    return new DriverAdapterError({
      kind: 'ForeignKeyConstraintViolation',
      constraint: { foreignKey: {} },
      originalCode: String(code),
      originalMessage: message,
    });
  if ((code & 0xff) === 5)
    return new DriverAdapterError({ kind: 'SocketTimeout' });
  return new DriverAdapterError({
    kind: 'sqlite',
    extendedCode: code,
    message,
    originalCode: String(code),
    originalMessage: message,
  });
}
