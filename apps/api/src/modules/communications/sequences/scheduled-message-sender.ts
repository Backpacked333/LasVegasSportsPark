import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OperationalExceptions,
  UnitOfWork,
  type PeriodicJob,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import { MessageScheduleService, SEND_SCHEDULED_MESSAGES_JOB } from './message-schedule.service';
import { MESSAGE_SEQUENCE_POLICY, type MessageSequencePolicy } from './message-sequences.policy';

export const SCHEDULED_MESSAGE_SEND_FAILED = 'communications.scheduled_message_send_failed';

/**
 * `communications.send_scheduled_messages` (SPK-COMMS-009, proposed amendment PA-05; K-06
 * periodic job, failure owner support). Sends the confirmed messages of sequences that are due at
 * the clock, each in its own small transaction (`MessageScheduleService.sendDue`): the row is
 * claimed with `FOR UPDATE SKIP LOCKED`, reviewed against its record as it is now, and handed to
 * the notification path, which resolves recipients, consent and preferences at that moment
 * (SPK-COMMS-003, SPK-COMMS-006, SPK-COMMS-007). Nothing that is not confirmed is ever sent, and
 * nothing is sent for an organization that has message sequences turned off. No provider is
 * called here: delivery stays with the delivery worker (§4.11).
 *
 * One message that cannot be sent never stalls the pass: its transaction rolls back, it stays
 * confirmed for the next run, and support gets one owned exception naming it.
 */
@Injectable()
export class ScheduledMessageSender {
  private readonly logger = new Logger(ScheduledMessageSender.name);

  constructor(
    @Inject(MESSAGE_SEQUENCE_POLICY) private readonly policy: MessageSequencePolicy,
    private readonly schedule: MessageScheduleService,
    private readonly uow: UnitOfWork,
    private readonly exceptions: OperationalExceptions,
  ) {}

  job(): PeriodicJob {
    return {
      name: SEND_SCHEDULED_MESSAGES_JOB,
      intervalSeconds: this.policy.sendIntervalSeconds,
      failureOwner: 'support_operator',
      run: (context) => this.run(context),
    };
  }

  async run({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const due = await this.schedule.dueCandidates(now, batchSize + 1);
    let processed = 0;
    for (const candidate of due.slice(0, batchSize)) {
      try {
        if (await this.schedule.sendDue(candidate.organization_id, candidate.id, now)) {
          processed += 1;
        }
      } catch (error) {
        await this.raiseFailure(candidate, error);
      }
    }
    return { processed, remaining: Math.max(0, due.length - batchSize) };
  }

  private async raiseFailure(
    candidate: { id: string; organization_id: string; facility_id: string },
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`scheduled message ${candidate.id} could not be sent: ${message}`);
    try {
      await this.uow.run(({ trx }) =>
        this.exceptions.raise(trx, {
          organizationId: candidate.organization_id,
          facilityId: candidate.facility_id,
          category: SCHEDULED_MESSAGE_SEND_FAILED,
          severity: 'warning',
          title: 'A confirmed message could not be sent when it was due',
          affectedType: 'scheduled_message',
          affectedId: candidate.id,
          ownerQueue: 'support_operator',
          dedupeKey: `communications:scheduled_message:${candidate.id}`,
          details: { scheduledMessageId: candidate.id, error: message },
        }),
      );
    } catch (raiseError) {
      this.logger.error(
        `could not raise the send failure of scheduled message ${candidate.id}: ${(raiseError as Error).message}`,
      );
    }
  }
}
