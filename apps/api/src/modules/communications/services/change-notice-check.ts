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

interface AttemptEvidence {
  recipient_id: string;
  channel: string;
  status: string;
  failure_code: string | null;
}

const reachedBy = (attempt: AttemptEvidence): boolean =>
  attempt.channel === 'in_app'
    ? IN_APP_REACHED.includes(attempt.status)
    : EXTERNAL_REACHED.includes(attempt.status);

/**
 * A push/email/SMS attempt that never was a way to reach the person, not a delivery that failed
 * (the worker raises none of these as a failed delivery either): the person switched the channel
 * off before the hand-off (CHANNEL_DISABLED; switching it off before dispatch creates no attempt
 * at all, so the person's state does not depend on when they chose), has no registered push
 * device (push NO_ADDRESS, COM-01), the attempt was withdrawn for a newer notice (SUPERSEDED), or
 * the recipient lost authority (RECIPIENT_REVOKED).
 */
const notAChannel = (attempt: AttemptEvidence): boolean =>
  attempt.status === 'failed' &&
  (attempt.failure_code === 'CHANNEL_DISABLED' ||
    attempt.failure_code === 'SUPERSEDED' ||
    attempt.failure_code === 'RECIPIENT_REVOKED' ||
    (attempt.channel === 'push' && attempt.failure_code === 'NO_ADDRESS'));

const sameInstant = (a: unknown, b: string | null | undefined): boolean =>
  typeof a === 'string' && !!b && new Date(a).getTime() === new Date(b).getTime();

/**
 * Fixture readiness "Material change notifications" (SPK-READY-001), registered as competition's
 * CHANGE_NOTICE_CHECK_IMPL. The evidence is this module's own: the schedule-change notices
 * composed for the fixture's scheduling event (subject `event`) that describe the fixture's
 * CURRENT time, and their delivery attempts (SPK-COMMS-004). Reads go through the caller's
 * transaction when there is one.
 *
 * The current notices are those composed since the last notice that went out describing another
 * time (or the cancellation): a fixture moved 14:00 → 16:00 → back to 14:00 is evidenced only by
 * the notices of the move back, never by the first 14:00 notice families were told before 16:00.
 * Notices suppressed as obsolete never went out and are skipped. A staff resend to one family is
 * one of the current notices, never a stand-in for the rest; while any current notice is still
 * composed or queued, the people it is for have not been told and the check is `unknown`.
 *
 * A person counts as told (R4-COMMS-AUTOMATION-06, §4.5 "actual delivery states") when a push,
 * email or SMS attempt was accepted by the provider (or better), or when they read or acknowledged
 * the in-app notice. The in-app copy that dispatch delivers to every inbox is not evidence of
 * anyone having been told.
 * - satisfied: every authorized recipient was told.
 * - unsatisfied: nobody could be notified (no recipients), or for a recipient who was not told
 *   every push/email/SMS attempt failed, the others having been told. An attempt that never was a
 *   way to reach them (`notAChannel`) is not a failure.
 * - unknown: no notice for the current time yet, one not sent yet, or a recipient's outcome still
 *   pending: external attempts queued or `unknown`, or only an unread in-app notice (never
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
      requiredAction = status === 'unknown'
        ? 'Wait for the change notice to be delivered, or confirm both teams were told.'
        : 'Tell both teams about the change directly.',
    ): ConditionFinding[] => [
      {
        status,
        code,
        message,
        source,
        responsibleRole: 'league_manager',
        requiredAction,
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
    const describesCurrent = (n: (typeof notices)[number]): boolean => {
      const after = (n.details_after ?? {}) as { scheduledStart?: unknown; scheduledEnd?: unknown };
      return (
        n.kind === 'schedule_changed' &&
        sameInstant(after.scheduledStart, context.scheduledStart) &&
        sameInstant(after.scheduledEnd, context.scheduledEnd)
      );
    };
    // The notices that describe the fixture's current time, newest first, back to the newest one
    // that went out describing another time: what people were told before that no longer holds.
    // One suppressed as obsolete never went out.
    const current: typeof notices = [];
    for (const n of notices) {
      if (n.status === 'suppressed' && n.suppression_reason === 'obsolete') continue;
      if (describesCurrent(n)) current.push(n);
      else if (n.status === 'dispatched') break;
    }
    const newest = current[0];
    if (!newest) {
      return finding(
        'unknown',
        'change_notification_pending',
        'No notice of the current schedule has been composed for the teams yet.',
      );
    }
    // A current notice not sent yet: the people it is for have not been told, whatever an older
    // (narrower) notice reached.
    const pending = current.find((n) => n.status === 'composed' || n.status === 'queued');
    if (pending) {
      return finding(
        'unknown',
        'change_notification_pending',
        'The change notice has not been sent yet.',
        { type: 'notification', id: pending.id },
      );
    }
    const dispatched = current.filter((n) => n.status === 'dispatched');
    const notSent = (id: string): ConditionFinding[] =>
      finding(
        'unsatisfied',
        'change_notification_not_sent',
        'The change notice reached no recipient (nobody could be notified).',
        { type: 'notification', id },
        'Check who the change notice is addressed to and send it again, or tell both teams directly.',
      );
    if (dispatched.length === 0) return notSent(newest.id);
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
    if (people.size === 0) return notSent(source.id);
    const attempts = await db
      .selectFrom('delivery_attempts')
      .select(['recipient_id', 'channel', 'status', 'failure_code'])
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
      // Only a channel that could have reached the person fails them; with none, the unread
      // in-app notice is all there is, and that is unknown, not a failure.
      const external = own.filter((a) => a.channel !== 'in_app' && !notAChannel(a));
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
        'Retry the failed deliveries from the notice once the contact details are fixed, or tell the people directly; this clears once a delivery is accepted or they open the in-app notice.',
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
