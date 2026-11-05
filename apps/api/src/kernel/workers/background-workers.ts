import { Injectable, Logger } from '@nestjs/common';

export interface BackgroundWorker {
  /** Stable name, for logs (`<module>.<worker>`). */
  name: string;
  start(): void;
  /**
   * Ends the loop: no new pass starts. A worker that can finish its pass in flight returns a
   * promise that resolves once it has (R3-OPERATIONS-10); `worker.ts` awaits it, bounded by
   * WORKER_SHUTDOWN_TIMEOUT_MS, before it closes the database and exits.
   */
  stop(): void | Promise<void>;
}

/**
 * The polling loops that belong to the independently running worker process (§4.1, §4.12), such
 * as provider-facing refund, installment and message delivery workers. Modules register them in
 * `onModuleInit`; only `worker.ts` starts them, so request-serving API processes never run
 * provider calls or scale the polling load with their replicas. Tests drive each worker's
 * `runOnce()` directly.
 */
@Injectable()
export class BackgroundWorkers {
  private readonly logger = new Logger(BackgroundWorkers.name);
  private readonly workers = new Map<string, BackgroundWorker>();
  private started = false;

  register(worker: BackgroundWorker): void {
    if (this.workers.has(worker.name)) {
      throw new Error(`background worker ${worker.name} is already registered`);
    }
    this.workers.set(worker.name, worker);
    if (this.started) worker.start();
  }

  names(): string[] {
    return [...this.workers.keys()];
  }

  isStarted(): boolean {
    return this.started;
  }

  startAll(): void {
    if (this.started) return;
    this.started = true;
    for (const worker of this.workers.values()) {
      worker.start();
      this.logger.log(`started ${worker.name}`);
    }
  }

  /**
   * Stops every worker at once (each loop ends before this returns its promise) and resolves once
   * every pass in flight has finished (R3-OPERATIONS-10). A worker whose stop fails is logged.
   */
  stopAll(): Promise<void> {
    this.started = false;
    const stopping: Array<Promise<void>> = [];
    for (const worker of this.workers.values()) {
      try {
        stopping.push(
          Promise.resolve(worker.stop()).catch((error: unknown) => {
            this.logger.warn(`stopping ${worker.name} failed: ${String(error)}`);
          }),
        );
      } catch (error) {
        this.logger.warn(`stopping ${worker.name} failed: ${String(error)}`);
      }
    }
    return Promise.all(stopping).then(() => undefined);
  }
}
