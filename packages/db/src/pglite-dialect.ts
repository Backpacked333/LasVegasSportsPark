import type { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

/**
 * Kysely dialect over an in-process PGlite database (real PostgreSQL compiled to WebAssembly).
 * PGlite executes on a single connection, so this driver serializes connection use with a mutex.
 * Consequence: true concurrency (two transactions interleaving) cannot be exercised here; the
 * CI job that runs the same suite against a PostgreSQL service covers that (see .github/workflows/ci.yml).
 */
class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  acquire(timeoutMs: number): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((r) => r !== release);
        reject(
          new Error(
            `PGlite connection wait exceeded ${timeoutMs}ms. Under PGlite only one connection exists: ` +
              'using the root database inside an open transaction (instead of the trx handle) deadlocks.',
          ),
        );
      }, timeoutMs);
      const release = () => {
        clearTimeout(timer);
        resolve();
      };
      this.queue.push(release);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly pglite: PGlite) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const params = [...compiledQuery.parameters];
    if (params.length === 0) {
      // Simple protocol: supports multi-statement SQL (migrations, BEGIN/COMMIT).
      const results = await this.pglite.exec(compiledQuery.sql);
      const last = results[results.length - 1];
      return {
        rows: (last?.rows ?? []) as R[],
        numAffectedRows: BigInt(last?.affectedRows ?? 0),
      };
    }
    const result = await this.pglite.query<R>(compiledQuery.sql, params);
    return {
      rows: result.rows,
      numAffectedRows: BigInt(result.affectedRows ?? 0),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('PGlite dialect does not support streaming queries');
  }
}

class PGliteDriver implements Driver {
  private readonly mutex = new Mutex();
  private readonly connection: PGliteConnection;

  constructor(
    private readonly pglite: PGlite,
    private readonly waitTimeoutMs: number,
  ) {
    this.connection = new PGliteConnection(pglite);
  }

  async init(): Promise<void> {
    await this.pglite.waitReady;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.mutex.acquire(this.waitTimeoutMs);
    return this.connection;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const isolation = settings.isolationLevel ? ` isolation level ${settings.isolationLevel}` : '';
    await connection.executeQuery(CompiledQuery.raw(`begin${isolation}`));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async savepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw(`savepoint "${savepointName}"`));
  }

  async rollbackToSavepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw(`rollback to savepoint "${savepointName}"`));
  }

  async releaseSavepoint(connection: DatabaseConnection, savepointName: string): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw(`release savepoint "${savepointName}"`));
  }

  async releaseConnection(): Promise<void> {
    this.mutex.release();
  }

  async destroy(): Promise<void> {
    await this.pglite.close();
  }
}

export interface PGliteDialectOptions {
  pglite: PGlite;
  /** How long a caller may wait for the single connection before failing loudly. */
  connectionWaitTimeoutMs?: number;
}

export class PGliteDialect implements Dialect {
  constructor(private readonly options: PGliteDialectOptions) {}

  createDriver(): Driver {
    return new PGliteDriver(this.options.pglite, this.options.connectionWaitTimeoutMs ?? 20_000);
  }

  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }
}
