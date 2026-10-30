import { Inject, Injectable } from '@nestjs/common';
import { newId, systemPrincipal, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import type { AssignmentNoticeKind } from '@sportspark/db';
import {
  CLOCK,
  FacilityDirectory,
  type Clock,
  type HandlerContext,
  type Trx,
} from '../../../kernel';
import {
  COMMUNICATIONS_POLICY,
  NotificationsService,
  type CommunicationsPolicy,
} from '../../communications';
import { localDateOf, localTimeOf } from '../../scheduling';
import { WorkforceEvents } from '../workforce.events';
import { actorView } from '../workforce.shared';

type AssignmentChanged = EventPayload<typeof WorkforceEvents.assignmentChanged>;

/** What an assignee is told about one `workforce.assignment_changed`. */
type Notice = 'offered' | 'rescheduled' | 'withdrawn' | 'declined';

interface Times {
  start: Date;
  end: Date;
}

const sameTimes = (a: Times, b: Times): boolean =>
  a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();

/** The assignment's earlier notices, as they stand for a notice of kind `composing` (0705). */
interface NoticeHistory {
  /** Sequence of the newest row (0 when none): the next row takes the following number. */
  lastSequence: number;
  /** The time stated by the newest notice the assignee was told, or will still be told. */
  told: Times | null;
  /**
   * The time stated by the newest notice that was not suppressed: the told one, or a newer unsent
   * one that the notice being composed makes obsolete.
   */
  newest: Times | null;
  /** An unsent notice about the assignment becomes obsolete when the new one is queued. */
  obsoletesUnsent: boolean;
}

/**
 * Assignment notices (WRK-04; SPK-COMMS-002 `assignment_offer`, "schedule change" and
 * "cancellation", SPK-COMMS-005, SPK-STAFF-002, IF-22). Communications does not import workforce,
 * so workforce composes its own notices from its own `workforce.assignment_changed`, in the
 * handler's transaction, through `NotificationsService.composeAndQueueIn` with `sourceEventId` =
 * the event id (one notice per event: a replay composes nothing new; the dispatcher's consumption
 * record and the notices' unique source-event key both hold it). Every notice has subject
 * (`assignment`, id), is recorded in `assignment_notices` with the time it stated, and is composed
 * under the assignment's row lock, so one assignment's notices are composed one at a time.
 *
 * The practical details (slot, facility, times) are the assignment's CURRENT ones, read in the
 * handler's transaction, never the payload's: a delivery can arrive late, after the activity moved
 * again (§4.12), and must not tell the assignee a time that no longer holds. The "previous" time
 * is the one the assignee was last TOLD (the newest recorded notice that was delivered, or is
 * still to be delivered and is not made obsolete by the new notice), never a time from a notice
 * suppressed unsent and never a time nobody told them.
 *
 *  - An assignment moved into `offered` (an offer, or a proposal created as offered): the assignee
 *    is told what is offered, where and when (facility-local time, SPK-SCHED-008), unless the
 *    offer is no longer standing when the handler runs. Kind `assignment_offer`.
 *  - An offered or accepted assignment moved with its activity (a retime keeps the status): the
 *    assignee is told the new time and the time they were last told, both also as the notice's
 *    practical details (SPK-COMMS-005). Nothing is composed when nothing was told yet (the offer
 *    notice still to come states the current time) or when the newest notice already states the
 *    current time (a late or repeated delivery). Kind `schedule_changed`: queued, it makes an
 *    unsent older move notice about the assignment obsolete (communications suppresses it).
 *  - An offered or accepted assignment withdrawn by someone other than the assignee (staff, a
 *    replacement, or a follow-up such as a canceled activity, a retired requirement or a move into
 *    a conflict): the assignee is told, with the time they were last told and, when the activity
 *    has moved since, its current time. An offer is only withdrawn-noticed when its offer notice
 *    was composed. Kind `cancellation`, so an unsent move notice about the assignment is
 *    suppressed and a sent one points at the cancellation.
 *  - The assignee's own decline or withdrawal composes nothing, except when an unsent move notice
 *    about the assignment is still waiting: a short confirmation (kind `cancellation`) then makes
 *    it obsolete, so "accept or decline it" or "you remain assigned" never arrives afterwards.
 *
 * `detailsBefore`/`detailsAfter` carry the shape clients read for schedule notices (title, status,
 * scheduledStart/End, timezone, facilityId, resources) plus a facility-local `summary`. It is a
 * staff notice to the assignee named by id (not protected customer content). Offer deadlines and
 * reminders are not added: they are pending DEC-011.
 */
@Injectable()
export class AssignmentNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly facilities: FacilityDirectory,
    @Inject(COMMUNICATIONS_POLICY) private readonly policy: CommunicationsPolicy,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onAssignmentChanged(
    event: DomainEvent<AssignmentChanged>,
    ctx: HandlerContext,
  ): Promise<void> {
    const p = event.payload;
    const previous: Times | null =
      p.previousScheduledStart && p.previousScheduledEnd
        ? { start: new Date(p.previousScheduledStart), end: new Date(p.previousScheduledEnd) }
        : null;
    const moved =
      previous !== null &&
      !sameTimes(previous, { start: new Date(p.scheduledStart), end: new Date(p.scheduledEnd) });
    const notice: Notice | null =
      p.status === 'offered' && p.previousStatus !== 'offered'
        ? 'offered'
        : p.status === 'withdrawn' &&
            (p.previousStatus === 'accepted' || p.previousStatus === 'offered')
          ? 'withdrawn'
          : p.status === 'declined' && p.previousStatus === 'offered'
            ? 'declined'
            : moved &&
                p.status === p.previousStatus &&
                (p.status === 'offered' || p.status === 'accepted')
              ? 'rescheduled'
              : null;
    if (!notice) return;
    // The row lock orders this assignment's notices (sequence, history) across workers.
    const row = await ctx.trx
      .selectFrom('assignments')
      .select([
        'id',
        'status',
        'person_id',
        'role',
        'slot',
        'facility_id',
        'target_title',
        'scheduled_start',
        'scheduled_end',
        'withdrawn_by',
      ])
      .where('organization_id', '=', event.organizationId)
      .where('id', '=', p.assignmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    // An offer already answered or retracted needs no notice.
    if (notice === 'offered' && row.status !== 'offered') return;
    // Declined or withdrawn since: that change is what matters (and is told on its own event).
    if (notice === 'rescheduled' && row.status !== 'offered' && row.status !== 'accepted') return;

    const kind: AssignmentNoticeKind =
      notice === 'offered'
        ? 'assignment_offer'
        : notice === 'rescheduled'
          ? 'schedule_changed'
          : 'cancellation';
    const history = await this.history(ctx.trx, event.organizationId, row.id, kind);
    const current: Times = {
      start: new Date(row.scheduled_start),
      end: new Date(row.scheduled_end),
    };
    // The assignee's own answer: a decline (only the assignee declines) or their own withdrawal.
    const self =
      notice === 'declined' ||
      (notice === 'withdrawn' && actorView(row.withdrawn_by).personId === row.person_id);
    if (notice === 'rescheduled') {
      // Nothing told yet (the offer notice still to come states the current time), or the newest
      // notice already states it (a late, repeated or reordered delivery, §4.12).
      if (!history.newest || !history.told || sameTimes(history.newest, current)) return;
    }
    // The assignee's own answer is only confirmed to make a waiting move notice obsolete.
    if (self && !history.obsoletesUnsent) return;
    // An offer nobody was told of needs no withdrawal notice.
    if (notice === 'withdrawn' && !self && p.previousStatus === 'offered' && !history.newest) {
      return;
    }

    const facility = (
      await this.facilities.describe(event.organizationId, [row.facility_id], ctx.trx)
    ).get(row.facility_id);
    const timezone = facility?.timezone ?? 'UTC';
    const when = (times: Times): string => {
      const startDate = localDateOf(timezone, times.start);
      const endDate = localDateOf(timezone, times.end);
      return startDate === endDate
        ? `${startDate} ${localTimeOf(timezone, times.start)}-${localTimeOf(timezone, times.end)}`
        : `${startDate} ${localTimeOf(timezone, times.start)} to ${endDate} ${localTimeOf(timezone, times.end)}`;
    };
    const role = row.role.replaceAll('_', ' ');
    const place = facility ? ` at ${facility.name}` : '';
    const what = `${role} (slot ${row.slot}) for ${row.target_title}${place}`;
    // The shape clients read for schedule notices (mobile `parseEventDetails`, staff `summaryOf`).
    const details = (times: Times, status: string) => ({
      summary: `${when(times)} (${timezone}): ${what}, ${status}`,
      title: row.target_title,
      status,
      scheduledStart: times.start.toISOString(),
      scheduledEnd: times.end.toISOString(),
      timezone,
      facilityId: row.facility_id,
      resources: [] as { id: string; name: string }[],
      role: row.role,
      slot: row.slot,
    });
    // The time the assignee knows the assignment by: last told; for accepted work never told of
    // (no recorded notice), the time before the move that withdrew it, or the current one.
    const known: Times = history.told ?? (moved && previous ? previous : current);
    const nowClause = sameTimes(known, current) ? '' : ` The activity is now ${when(current)}.`;
    const because = p.reason ? `: ${p.reason}${/[.!?]$/.test(p.reason) ? '' : '.'}` : '.';

    let title: string;
    let body: string;
    let detailsBefore: Record<string, unknown> | undefined;
    let detailsAfter: Record<string, unknown> | undefined;
    if (notice === 'offered') {
      title = `Assignment offered: ${role}`;
      body = `You are offered the ${what}, ${when(current)} (${timezone}). Open your assignments to accept or decline it.`;
    } else if (notice === 'rescheduled') {
      const unchanged = sameTimes(known, current);
      const suffix =
        row.status === 'offered'
          ? ' Open your assignments to accept or decline it.'
          : unchanged
            ? ' You remain assigned.'
            : ' You remain assigned at the new time.';
      if (unchanged) {
        // Moved and moved back before the move notice went out: that notice no longer applies,
        // and this one (superseding it) tells the assignee the time they know still stands.
        title = `Assignment time unchanged: ${role}`;
        body = `Your ${row.status} ${what} stays at ${when(current)} (${timezone}).${suffix}`;
      } else {
        title = `Assignment rescheduled: ${role}`;
        body = `Your ${row.status} ${what} was rescheduled: now ${when(current)} (${timezone}), previously ${when(known)}.${suffix}`;
      }
      detailsBefore = details(known, row.status);
      detailsAfter = details(current, row.status);
    } else if (self) {
      title = `${notice === 'declined' ? 'Decline' : 'Withdrawal'} recorded: ${role}`;
      body =
        notice === 'declined'
          ? `You declined the offered ${what}, ${when(known)} (${timezone}).${nowClause}`
          : `You withdrew from the ${p.previousStatus} ${what}, ${when(known)} (${timezone}).${nowClause}`;
      detailsBefore = details(known, p.previousStatus ?? 'offered');
      detailsAfter = details(current, row.status);
    } else if (p.previousStatus === 'offered') {
      title = `Assignment offer withdrawn: ${role}`;
      body = `The offer of the ${what}, ${when(known)} (${timezone}), was withdrawn${because} You no longer need to answer it.${nowClause}`;
      detailsBefore = details(known, 'offered');
      detailsAfter = details(current, 'withdrawn');
    } else {
      title = `Assignment withdrawn: ${role}`;
      body = `Your accepted ${what}, ${when(known)} (${timezone}), was withdrawn${because}${nowClause}`;
      detailsBefore = details(known, 'accepted');
      detailsAfter = details(current, 'withdrawn');
    }
    const notification = await this.notifications.composeAndQueueIn(
      ctx.trx,
      systemPrincipal(event.organizationId, 'workforce.notices'),
      {
        kind,
        category: 'operational',
        facilityId: row.facility_id,
        subject: { type: 'assignment', id: row.id },
        audience: { personIds: [row.person_id] },
        title: title.slice(0, 200),
        body: body.slice(0, 4000),
        ...(detailsBefore ? { detailsBefore } : {}),
        ...(detailsAfter ? { detailsAfter } : {}),
        protected: false,
        sourceEventId: event.id,
        correlationId: event.correlationId,
      },
    );
    await ctx.trx
      .insertInto('assignment_notices')
      .values({
        id: newId(),
        organization_id: event.organizationId,
        assignment_id: row.id,
        sequence: history.lastSequence + 1,
        notice_kind: kind,
        notification_id: notification.id,
        source_event_id: event.id,
        stated_start: current.start,
        stated_end: current.end,
        created_at: this.clock.now(),
      })
      .execute();
  }

  /**
   * What the assignee was told about the assignment, newest first (migration 0705). A notice
   * suppressed unsent was never told; an unsent one that the new notice of kind `composing` makes
   * obsolete (communications' superseding rule, SPK-COMMS-005) will never be told either. The
   * notices' status is read through communications' service, never its tables.
   */
  private async history(
    trx: Trx,
    organizationId: string,
    assignmentId: string,
    composing: AssignmentNoticeKind,
  ): Promise<NoticeHistory> {
    const rows = await trx
      .selectFrom('assignment_notices')
      .select(['sequence', 'notification_id', 'stated_start', 'stated_end'])
      .where('organization_id', '=', organizationId)
      .where('assignment_id', '=', assignmentId)
      .orderBy('sequence', 'desc')
      .execute();
    const history: NoticeHistory = {
      lastSequence: rows[0]?.sequence ?? 0,
      told: null,
      newest: null,
      obsoletesUnsent: false,
    };
    const supersedes = this.policy.supersedingKinds.includes(composing);
    for (const r of rows) {
      const notification = await this.notifications.load(trx, organizationId, r.notification_id);
      if (!notification || notification.status === 'suppressed') continue;
      const stated = { start: new Date(r.stated_start), end: new Date(r.stated_end) };
      history.newest ??= stated;
      const unsent = notification.status === 'composed' || notification.status === 'queued';
      if (unsent && supersedes && this.policy.supersedableKinds.includes(notification.kind)) {
        history.obsoletesUnsent = true;
        continue;
      }
      history.told = stated;
      break;
    }
    return history;
  }
}
