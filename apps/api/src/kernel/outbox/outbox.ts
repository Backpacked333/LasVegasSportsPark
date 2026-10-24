import { Inject, Injectable } from '@nestjs/common';
import {
  newId,
  type DomainEvent,
  type EventDefinition,
  type EventPayload,
} from '@sportspark/contracts';
import { json } from '@sportspark/db';
import type { ZodType } from 'zod';
import type { Clock } from '../clock';
import type { Trx } from '../database/unit-of-work';
import { CLOCK } from '../tokens';

export interface EnqueueInput<TPayload> {
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  correlationId?: string | null;
  causationId?: string | null;
  operationId?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
  /**
   * The producer's owner queue for a dead letter (§4.12). A failing handler's own
   * `failureOwner` wins, because one event fans out to handlers in several modules.
   */
  failureOwner?: string | null;
}

/** Transactional outbox writer (§4.12): events are stored in the same transaction as the business change. */
@Injectable()
export class Outbox {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async enqueue<TDef extends EventDefinition<string, ZodType>>(
    trx: Trx,
    definition: TDef,
    input: EnqueueInput<EventPayload<TDef>>,
  ): Promise<DomainEvent<EventPayload<TDef>>>;
  async enqueue<TPayload>(
    trx: Trx,
    type: string,
    input: EnqueueInput<TPayload>,
  ): Promise<DomainEvent<TPayload>>;
  async enqueue<TPayload>(
    trx: Trx,
    typeOrDefinition: string | EventDefinition<string, ZodType>,
    input: EnqueueInput<TPayload>,
  ): Promise<DomainEvent<TPayload>> {
    const type = typeof typeOrDefinition === 'string' ? typeOrDefinition : typeOrDefinition.type;
    if (typeof typeOrDefinition !== 'string') {
      typeOrDefinition.payload.parse(input.payload);
    }
    const occurredAt = this.clock.now();
    const event: DomainEvent<TPayload> = {
      id: newId(),
      type,
      organizationId: input.organizationId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      occurredAt: occurredAt.toISOString(),
      payload: input.payload,
      correlationId: input.correlationId ?? null,
      causationId: input.causationId ?? null,
      operationId: input.operationId ?? null,
    };
    await trx
      .insertInto('outbox_events')
      .values({
        id: event.id,
        organization_id: event.organizationId,
        event_type: event.type,
        aggregate_type: event.aggregateType,
        aggregate_id: event.aggregateId,
        payload: json(event.payload as object),
        occurred_at: occurredAt,
        correlation_id: event.correlationId,
        causation_id: event.causationId,
        operation_id: event.operationId,
        available_at: input.availableAt ?? occurredAt,
        max_attempts: input.maxAttempts ?? 10,
        last_error: null,
        locked_by: null,
        locked_until: null,
        dispatched_at: null,
        failure_owner: input.failureOwner ?? null,
      })
      .execute();
    return event;
  }
}
