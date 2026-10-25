import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
import type {
  ChangeNoticeCheckPort,
  ConditionFinding,
  FixtureConditionContext,
} from '../../competition';

type NoticeContext = FixtureConditionContext & {
  changedAt: Date;
  schedulingEventId: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
};

/** Attempt states that are evidence the notice reached the recipient's channel (§4.5). */
const REACHED = ['provider_accepted', 'delivered', 'read', 'acknowledged'];

const sameInstant = (a: unknown, b: string | null | undefined): boolean =>
  typeof a === 'string' && !!b && new Date(a).getTime() === new Date(b).getTime();

/**
 * Fixture readiness "Material change notifications" (SPK-READY-001), registered as competition's
 * CHANGE_NOTICE_CHECK_IMPL. The evidence is this module's own: the schedule-change notice
 * composed for the fixture's scheduling event (subject `event`) that describes the fixture's
 * CURRENT time, and its delivery attempts (SPK-COMMS-004). Reads go through the caller's
 * transaction when there is one.
 *
 * - satisfied: every authorized recipient has an attempt the provider accepted (or better).
 * - unsatisfied: nobody could be notified (no recipients), or a recipient's attempts all failed.
 * - unknown: no notice for the current time yet, not dispatched yet, or outcomes still pending or
 *   unknown (never reported as delivered without evidence, SPK-READY-002).
 */
@Injectable()
export class ChangeNoticeCheck implements ChangeNoticeCheckPort {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async changeNotices(
    organizationId: string,
    context: NoticeContext,
    trx?: Trx,
  ): Promise<ConditionFinding[]> {
    const db = trx ?? executorFor(this.db);
    const finding = (
      status: ConditionFinding['status'],
      code: string,
      message: string,
      source: ConditionFinding['source'] = { type: 'fixture', id: context.fixtureId },
    ): ConditionFinding[] => [
      {
        status,
        code,
        message,
        source,
        responsibleRole: 'league_manager',
        requiredAction:
          status === 'unknown'
            ? 'Wait for the change notice to be delivered, or confirm both teams were told.'
            : 'Tell both teams about the change directly and record it.',
        deadline: null,
      },
    ];
    if (!context.schedulingEventId) {
      return finding(
        'unknown',
        'change_notification_unknown',
        `The fixture changed materially on ${context.changedAt.toISOString()} and has no current scheduling event; delivery of the change notice cannot be confirmed.`,
      );
    }
    const notices = await db
      .selectFrom('notifications')
      .select(['id', 'kind', 'status', 'suppression_reason', 'details_after'])
      .where('organization_id', '=', organizationId)
      .where('subject_type', '=', 'event')
      .where('subject_id', '=', context.schedulingEventId)
      .where('kind', 'in', ['schedule_changed', 'cancellation'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    // The notice that describes the fixture's current time (an older notice describes a time that
    // no longer holds; one superseded as obsolete never went out).
    const notice = notices.find((n) => {
      if (n.status === 'suppressed' && n.suppression_reason === 'obsolete') return false;
      const after = (n.details_after ?? {}) as { scheduledStart?: unknown; scheduledEnd?: unknown };
      return (
        n.kind === 'schedule_changed' &&
        sameInstant(after.scheduledStart, context.scheduledStart) &&
        sameInstant(after.scheduledEnd, context.scheduledEnd)
      );
    });
    if (!notice) {
      return finding(
        'unknown',
        'change_notification_pending',
        'No notice of the current schedule has been composed for the teams yet.',
      );
    }
    const source = { type: 'notification', id: notice.id };
    if (notice.status === 'suppressed') {
      return finding(
        'unsatisfied',
        'change_notification_not_sent',
        'The change notice reached no recipient (nobody could be notified).',
        source,
      );
    }
    if (notice.status !== 'dispatched') {
      return finding(
        'unknown',
        'change_notification_pending',
        'The change notice has not been sent yet.',
        source,
      );
    }
    const recipients = await db
      .selectFrom('notification_recipients')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', notice.id)
      .where('status', '=', 'authorized')
      .execute();
    if (recipients.length === 0) {
      return finding(
        'unsatisfied',
        'change_notification_not_sent',
        'The change notice reached no recipient (nobody could be notified).',
        source,
      );
    }
    const attempts = await db
      .selectFrom('delivery_attempts')
      .select(['recipient_id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('notification_id', '=', notice.id)
      .execute();
    let reached = 0;
    let failed = 0;
    for (const recipient of recipients) {
      const own = attempts.filter((a) => a.recipient_id === recipient.id);
      if (own.some((a) => REACHED.includes(a.status))) reached += 1;
      else if (own.length > 0 && own.every((a) => a.status === 'failed')) failed += 1;
    }
    if (reached === recipients.length) return [];
    if (failed > 0 && reached + failed === recipients.length) {
      return finding(
        'unsatisfied',
        'change_notification_failed',
        `The change notice could not be delivered to ${failed} of ${recipients.length} recipient(s).`,
        source,
      );
    }
    return finding(
      'unknown',
      'change_notification_unconfirmed',
      `Delivery of the change notice is confirmed for ${reached} of ${recipients.length} recipient(s).`,
      source,
    );
  }
}
