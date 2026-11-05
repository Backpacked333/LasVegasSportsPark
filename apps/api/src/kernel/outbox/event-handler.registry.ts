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
 *
 * R3-OPERATIONS-01 (§4.7 invariant 12, §5.8): the outbox records with every event the names this
 * registry holds for its type (`expectedFor`), and a dispatcher settles the event only once each
 * of them has run, so a build that lacks a handler (an older build during a rollback, or a worker
 * not yet upgraded in a rolling deploy) leaves the event for a build that has it. A handler that
 * is removed on purpose must be declared `retire`d under the same name, so events recorded while
 * it existed do not wait for it forever. Handlers are registered unconditionally in
 * `onModuleInit` (never by process role or environment), so the API processes that record events
 * and the workers that dispatch them expect the same handlers. The committed handler manifest
 * (`apps/api/src/__tests__/event-handler-manifest.json`) lists every name per event type, and its
 * test fails the build when a listed name is neither registered nor retired, so a rename or a
 * removal without `retire` cannot ship; a new handler is added to the manifest with its module.
 */
@Injectable()
export class EventHandlerRegistry {
  private readonly byType = new Map<string, RegisteredHandler[]>();
  private readonly retired = new Map<string, Map<string, string>>();

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
    if (this.retired.get(eventType)?.has(name)) {
      throw new Error(`handler ${name} is retired for ${eventType}; register it under a new name`);
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

  /**
   * Declares that handler `name` no longer exists for `eventType` (R3-OPERATIONS-01): events an
   * earlier build recorded with it among their expected handlers are settled without it. Keep the
   * declaration for as long as such events may still be pending (at least one release).
   */
  retire(eventType: string, name: string, reason: string): void {
    if (this.handlersFor(eventType).some((h) => h.name === name)) {
      throw new Error(`handler ${name} is registered for ${eventType}; it cannot also be retired`);
    }
    if (!reason.trim()) throw new Error(`retiring handler ${name} needs a reason`);
    const names = this.retired.get(eventType) ?? new Map<string, string>();
    names.set(name, reason);
    this.retired.set(eventType, names);
  }

  isRetired(eventType: string, name: string): boolean {
    return this.retired.get(eventType)?.has(name) ?? false;
  }

  /** The handler names an event of this type expects, recorded with it by the outbox (sorted). */
  expectedFor(eventType: string): string[] {
    return this.handlersFor(eventType)
      .map((h) => h.name)
      .sort();
  }

  /**
   * Of the handlers an event expected when it was recorded, those this build neither registers nor
   * retired: the event must wait for a build that has them. Null expectations (rows recorded before
   * migration 0013) expect nothing.
   */
  missingFor(eventType: string, expected: readonly string[] | null): string[] {
    if (!expected || expected.length === 0) return [];
    const registered = new Set(this.handlersFor(eventType).map((h) => h.name));
    return expected.filter((name) => !registered.has(name) && !this.isRetired(eventType, name));
  }

  list(): RegisteredHandler[] {
    return [...this.byType.values()].flat();
  }

  /** The retired handler names, by event type (sorted). */
  retiredNames(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [eventType, names] of this.retired) out.set(eventType, [...names.keys()].sort());
    return out;
  }
}
