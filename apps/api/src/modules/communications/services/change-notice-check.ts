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

/** Push/email/SMS states that are evidence the notice reached the person's channel (§4.5). */
const EXTERNAL_REACHED = ['provider_accepted', 'delivered', 'read', 'acknowledged'];
/**
 * In-app: dispatch delivers every authorized recipient's inbox copy at once, so `delivered` says
 * nothing about the person being told; only their opening it does (R4-COMMS-AUTOMATION-06).
 */
const IN_APP_REACHED = ['read', 'acknowledged'];

const reachedBy = (attempt: { channel: string; status: string }): boolean =>
  attempt.channel === 'in_app'
    ? IN_APP_REACHED.includes(attempt.status)
    : EXTERNAL_REACHED.includes(attempt.status);

const sameInstant = (a: unknown, b: string | null | undefined): boolean =>
  typeof a === 'string' && !!b && new Date(a).getTime() === new Date(b).getTime();

/**
 * Fixture readiness "Material change notifications" (SPK-READY-001), registered as competition's
 * CHANGE_NOTICE_CHECK_IMPL. The evidence is this module's own: the schedule-change notices
 * composed for the fixture's scheduling event (subject `event`) that describe the fixture's
 * CURRENT time (a staff resend to one family is one of them, never a stand-in for the rest), and
 * their delivery attempts (SPK-COMMS-004). Reads go through the caller's transaction when there
 * is one.
 *
 * A person counts as told (R4-COMMS-AUTOMATION-06, §4.5 "actual delivery states") when a push,
 * email or SMS attempt was accepted by the provider (or better), or when they read or acknowledged
 * the in-app notice. The in-app copy that dispatch delivers to every inbox is not evidence of
 * anyone having been told.
 * - satisfied: every authorized recipient was told.
 * - unsatisfied: nobody could be notified (no recipients), or for a recipient who was not told
 *   every push/email/SMS attempt failed, the others having been told.
 * - unknown: no notice for the current time yet, not dispatched yet, or a recipient's outcome
 *   still pending: external attempts queued or `unknown`, or only an unread in-app notice (never
 *   reported as delivered without evidence, SPK-READY-002).
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
    // The notices that describe the fixture's current time (an older notice describes a time that
    // no longer holds; one suppressed as obsolete never went out), newest first.
    const current = notices.filter((n) => {
      if (n.status === 'suppressed' && n.suppression_reason === 'obsolete') return false;
      const after = (n.details_after ?? {}) as { scheduledStart?: unknown; scheduledEnd?: unknown };
      return (
        n.kind === 'schedule_changed' &&
        sameInstant(after.scheduledStart, context.scheduledStart) &&
        sameInstant(after.scheduledEnd, context.scheduledEnd)
      );
    });
    const newest = current[0];
    if (!newest) {
      return finding(
        'unknown',
        'change_notification_pending',
        'No notice of the current schedule has been composed for the teams yet.',
      );
    }
    const dispatched = current.filter((n) => n.status === 'dispatched');
    if (dispatched.length === 0) {
      const pending = current.find((n) => n.status !== 'suppressed');
      return pending
        ? finding(
            'unknown',
            'change_notification_pending',
            'The change notice has not been sent yet.',
            { type: 'notification', id: pending.id },
          )
        : finding(
            'unsatisfied',
            'change_notification_not_sent',
            'The change notice reached no recipient (nobody could be notified).',
            { type: 'notification', id: newest.id },
          );
    }
    const source = { type: 'notification', id: (dispatched[0] ?? newest).id };
    const ids = dispatched.map((n) => n.id);
    const recipients = await db
      .selectFrom('notification_recipients')
      .select(['id', 'person_id'])
      .where('organization_id', '=', organizationId)
      .where('notification_id', 'in', ids)
      .where('status', '=', 'authorized')
      .execute();
    // One person may be a recipient of several of these notices: told by any of them.
    const people = new Map<string, string[]>();
    for (const r of recipients) people.set(r.person_id, [...(people.get(r.person_id) ?? []), r.id]);
    if (people.size === 0) {
      return finding(
        'unsatisfied',
        'change_notification_not_sent',
        'The change notice reached no recipient (nobody could be notified).',
        source,
      );
    }
    const attempts = await db
      .selectFrom('delivery_attempts')
      .select(['recipient_id', 'channel', 'status'])
      .where('organization_id', '=', organizationId)
      .where('notification_id', 'in', ids)
      .execute();
    let reached = 0;
    let failed = 0;
    for (const recipientIds of people.values()) {
      const own = attempts.filter((a) => recipientIds.includes(a.recipient_id));
      if (own.some(reachedBy)) {
        reached += 1;
        continue;
      }
      const external = own.filter((a) => a.channel !== 'in_app');
      if (external.length > 0 && external.every((a) => a.status === 'failed')) failed += 1;
    }
    const total = people.size;
    if (reached === total) return [];
    if (failed > 0 && reached + failed === total) {
      return finding(
        'unsatisfied',
        'change_notification_failed',
        `The change notice could not be delivered to ${failed} of ${total} recipient(s).`,
        source,
      );
    }
    return finding(
      'unknown',
      'change_notification_unconfirmed',
      `Delivery of the change notice is confirmed for ${reached} of ${total} recipient(s) (an in-app notice counts once it is read).`,
      source,
    );
  }
}
