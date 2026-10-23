import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@sportspark/contracts';
import type { Trx } from '../database/unit-of-work';

export interface HandlerContext {
  trx: Trx;
  attempt: number;
}

export type EventHandler<TPayload = unknown> = (
  event: DomainEvent<TPayload>,
  context: HandlerContext,
) => Promise<void>;

export interface RegisteredHandler {
  name: string;
  eventType: string;
  handler: EventHandler;
}

/**
 * Handlers subscribe to event types by stable handler name. Each (handler, event) pair runs at most
 * once with committed effects because the dispatcher records the consumption in the same transaction.
 */
@Injectable()
export class EventHandlerRegistry {
  private readonly byType = new Map<string, RegisteredHandler[]>();

  on<TPayload>(eventType: string, name: string, handler: EventHandler<TPayload>): void {
    const list = this.byType.get(eventType) ?? [];
    if (list.some((h) => h.name === name)) {
      throw new Error(`handler ${name} already registered for ${eventType}`);
    }
    list.push({ name, eventType, handler: handler as EventHandler });
    this.byType.set(eventType, list);
  }

  handlersFor(eventType: string): RegisteredHandler[] {
    return this.byType.get(eventType) ?? [];
  }

  list(): RegisteredHandler[] {
    return [...this.byType.values()].flat();
  }
}
