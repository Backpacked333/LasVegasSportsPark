import { Injectable } from '@nestjs/common';
import {
  systemPrincipal,
  type DomainEvent,
  type EventPayload,
  type NotificationKindValue,
} from '@sportspark/contracts';
import { FacilityDirectory, type HandlerContext } from '../../../kernel';
import { NotificationsService } from '../../communications';
import { localDateOf, localTimeOf } from '../../scheduling';
import { WorkforceEvents } from '../workforce.events';
import { actorView } from '../workforce.shared';

type AssignmentChanged = EventPayload<typeof WorkforceEvents.assignmentChanged>;

/** What an assignee is told about one `workforce.assignment_changed`. */
type Notice = 'offered' | 'rescheduled' | 'withdrawn';

const instant = (value: Date | string): number => new Date(value).getTime();

/**
 * Assignment notices (WRK-04; SPK-COMMS-002 `assignment_offer`, "schedule change" and
 * "cancellation", SPK-COMMS-005, SPK-STAFF-002, IF-22). Communications does not import workforce,
 * so workforce composes its own notices from its own `workforce.assignment_changed`, in the
 * handler's transaction, through `NotificationsService.composeAndQueueIn` with `sourceEventId` =
 * the event id (one notice per event: a replay composes nothing new; the dispatcher's consumption
 * record and the notices' unique source-event key both hold it).
 *
 * The practical details (slot, facility, times) are the assignment's CURRENT ones, read in the
 * handler's transaction, never the payload's: a delivery can arrive late, after the activity moved
 * again (§4.12), and must not tell the assignee a time that no longer holds.
 *
 *  - An assignment moved into `offered` (an offer, or a proposal created as offered): the assignee
 *    is told what is offered, where and when (facility-local time, SPK-SCHED-008), unless the
 *    offer is no longer standing when the handler runs. Kind `assignment_offer`.
 *  - An offered or accepted assignment moved with its activity (a retime keeps the status; the
 *    payload carries the previous times): the assignee is told the new and the previous time, with
 *    both as the notice's practical details (SPK-COMMS-005). Kind `schedule_changed`, so a newer
 *    move or a withdrawal suppresses it while unsent. A delivery whose times are no longer the
 *    assignment's composes nothing: the newer move's own event tells the current time.
 *  - An accepted assignment withdrawn by someone other than the assignee (staff, a replacement, or
 *    a follow-up such as a canceled activity, a retired requirement or a move into a conflict):
 *    the assignee is told, with the time they had accepted. Kind `cancellation`, so an unsent
 *    notice of an earlier move does not arrive after it.
 *
 * It is a staff notice to the assignee named by id (not protected customer content). Offer
 * deadlines and reminders are not added: they are pending DEC-011.
 */
@Injectable()
export class AssignmentNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly facilities: FacilityDirectory,
  ) {}

  async onAssignmentChanged(
    event: DomainEvent<AssignmentChanged>,
    ctx: HandlerContext,
  ): Promise<void> {
    const p = event.payload;
    const previous =
      p.previousScheduledStart && p.previousScheduledEnd
        ? { start: new Date(p.previousScheduledStart), end: new Date(p.previousScheduledEnd) }
        : null;
    const moved =
      previous !== null &&
      (previous.start.getTime() !== instant(p.scheduledStart) ||
        previous.end.getTime() !== instant(p.scheduledEnd));
    const notice: Notice | null =
      p.status === 'offered' && p.previousStatus !== 'offered'
        ? 'offered'
        : p.status === 'withdrawn' && p.previousStatus === 'accepted'
          ? 'withdrawn'
          : moved &&
              p.status === p.previousStatus &&
              (p.status === 'offered' || p.status === 'accepted')
            ? 'rescheduled'
            : null;
    if (!notice) return;
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
      .executeTakeFirst();
    if (!row) return;
    // An offer already answered or retracted needs no notice; a person's own withdrawal neither.
    if (notice === 'offered' && row.status !== 'offered') return;
    if (notice === 'withdrawn' && actorView(row.withdrawn_by).personId === row.person_id) return;
    if (notice === 'rescheduled') {
      // Declined or withdrawn since: that change is what matters (and is told on its own event).
      if (row.status !== 'offered' && row.status !== 'accepted') return;
      // Moved again since: the newer move's event tells the current time (§4.12).
      if (
        instant(row.scheduled_start) !== instant(p.scheduledStart) ||
        instant(row.scheduled_end) !== instant(p.scheduledEnd)
      ) {
        return;
      }
    }

    const facility = (
      await this.facilities.describe(event.organizationId, [row.facility_id], ctx.trx)
    ).get(row.facility_id);
    const timezone = facility?.timezone ?? 'UTC';
    const current = { start: new Date(row.scheduled_start), end: new Date(row.scheduled_end) };
    const when = (times: { start: Date; end: Date }): string => {
      const startDate = localDateOf(timezone, times.start);
      const endDate = localDateOf(timezone, times.end);
      return startDate === endDate
        ? `${startDate} ${localTimeOf(timezone, times.start)}-${localTimeOf(timezone, times.end)}`
        : `${startDate} ${localTimeOf(timezone, times.start)} to ${endDate} ${localTimeOf(timezone, times.end)}`;
    };
    const role = row.role.replaceAll('_', ' ');
    const place = facility ? ` at ${facility.name}` : '';
    const what = `${role} (slot ${row.slot}) for ${row.target_title}${place}`;
    const details = (times: { start: Date; end: Date }) => ({
      facilityId: row.facility_id,
      timezone,
      slot: row.slot,
      scheduledStart: times.start.toISOString(),
      scheduledEnd: times.end.toISOString(),
    });

    let kind: NotificationKindValue;
    let title: string;
    let body: string;
    let detailsBefore: Record<string, unknown> | undefined;
    let detailsAfter: Record<string, unknown> | undefined;
    if (notice === 'offered') {
      kind = 'assignment_offer';
      title = `Assignment offered: ${role}`;
      body = `You are offered the ${what}, ${when(current)} (${timezone}). Open your assignments to accept or decline it.`;
    } else if (notice === 'rescheduled') {
      const was = previous as { start: Date; end: Date };
      kind = 'schedule_changed';
      title = `Assignment rescheduled: ${role}`;
      body =
        `Your ${row.status} ${what} was rescheduled: now ${when(current)} (${timezone}), previously ${when(was)}.` +
        (row.status === 'offered'
          ? ' Open your assignments to accept or decline it.'
          : ' You remain assigned at the new time.');
      detailsBefore = details(was);
      detailsAfter = details(current);
    } else {
      // The time the assignee had accepted: before the move when the move itself withdrew it.
      const accepted = moved ? (previous as { start: Date; end: Date }) : current;
      kind = 'cancellation';
      title = `Assignment withdrawn: ${role}`;
      body =
        `Your accepted ${what}, ${when(accepted)} (${timezone}), was withdrawn${p.reason ? `: ${p.reason}` : '.'}` +
        (moved ? ` The activity is now ${when(current)}.` : '');
      if (moved) {
        detailsBefore = details(accepted);
        detailsAfter = details(current);
      }
    }
    await this.notifications.composeAndQueueIn(
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
  }
}
