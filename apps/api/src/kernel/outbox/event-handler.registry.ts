import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@sportspark/contracts';
import type { Trx } from '../database/unit-of-work';

/**
 * What an outbox or inbox handler receives. The handler also runs inside the transaction context
 * (`currentTransaction()` is `trx`), so ports and `UnitOfWork.reader()` read through it.
 */
export interface HandlerContext {
  trx: Trx;
  attempt: number;
  /**
   * Best-effort hook run after the handler's consumption transaction commits (for example to
   * nudge a worker); never on rollback, and not when the event was already consumed. Durable
   * follow-up MUST go through the outbox in the same transaction; after-commit hooks are not durable.
   */
  afterCommit(hook: () => void | Promise<void>): void;
}

/** Runs after-commit hooks outside any transaction context; a failing hook is logged, never thrown. */
export async function runAfterCommitHooks(
  hooks: Array<() => void | Promise<void>>,
  onError: (error: unknown) => void,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      onError(error);
    }
  }
}

export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
  context: HandlerContext,
) => Promise<void>;

export interface RegisteredHandler {
  name: string;
  eventType: string;
  handler: EventHandler;
  /**
   * The queue that owns this handler's failures (§4.12 "failure owner", SPK-UX-006 "owner or
   * responsible queue"): a dead-lettered event names the owner of the handler that failed.
   */
  failureOwner?: string;
}

export interface HandlerOptions {
  /** Owner queue (by convention a staff role name) for this handler's dead letters. */
  failureOwner?: string;
}

/**
 * Handlers subscribe to event types by stable handler name. Each (handler, event) pair runs at most
 * once with committed effects because the dispatcher records the consumption in the same transaction.
 */
@Injectable()
export class EventHandlerRegistry {
  private readonly byType = new Map<string, RegisteredHandler[]>();

  on<TPayload>(
    eventType: string,
    name: string,
    handler: EventHandler<TPayload>,
    options: HandlerOptions = {},
  ): void {
    const list = this.byType.get(eventType) ?? [];
    if (list.some((h) => h.name === name)) {
      throw new Error(`handler ${name} already registered for ${eventType}`);
    }
    list.push({
      name,
      eventType,
      handler: handler as EventHandler,
      ...(options.failureOwner ? { failureOwner: options.failureOwner } : {}),
    });
    this.byType.set(eventType, list);
  }

  handlersFor(eventType: string): RegisteredHandler[] {
    return this.byType.get(eventType) ?? [];
  }

  list(): RegisteredHandler[] {
    return [...this.byType.values()].flat();
  }
}
