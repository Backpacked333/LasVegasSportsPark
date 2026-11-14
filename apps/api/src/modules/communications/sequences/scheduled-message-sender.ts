import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OperationalExceptions,
  UnitOfWork,
  type PeriodicJob,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import {
  MessageScheduleService,
  SEND_SCHEDULED_MESSAGES_JOB,
  type DueCandidate,
} from './message-schedule.service';
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
 * A pass handles up to `batchSize` messages and reads the due ones page by page, oldest first.
 * Messages it cannot send now are passed over, never waited for: those of an organization with
 * the switch off (they stay confirmed), and one that fails (its transaction rolls back, it stays
 * confirmed for the next run, and support gets one owned exception naming it). So neither holds
 * back the messages behind it.
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
    const enabled = new Map<string, boolean>();
    let processed = 0;
    let after: DueCandidate | null = null;
    for (;;) {
      const page = await this.schedule.dueCandidates(now, batchSize, after);
      for (const candidate of page) {
        // The batch is full: the rest waits for the next pass of this run.
        if (processed >= batchSize) return { processed, remaining: 1 };
        let on = enabled.get(candidate.organization_id);
        if (on === undefined) {
          on = await this.schedule.sendingEnabled(candidate.organization_id);
          enabled.set(candidate.organization_id, on);
        }
        if (!on) continue; // switched off: the confirmed message waits as it is
        try {
          if (await this.schedule.sendDue(candidate.organization_id, candidate.id, now)) {
            processed += 1;
          }
        } catch (error) {
          await this.raiseFailure(candidate, error);
        }
      }
      if (page.length < batchSize) return { processed, remaining: 0 };
      after = page[page.length - 1] ?? null;
    }
  }

  private async raiseFailure(candidate: DueCandidate, error: unknown): Promise<void> {
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
