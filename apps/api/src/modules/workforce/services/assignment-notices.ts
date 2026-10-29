import { Injectable } from '@nestjs/common';
import { systemPrincipal, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { FacilityDirectory, type HandlerContext } from '../../../kernel';
import { NotificationsService } from '../../communications';
import { localDateOf, localTimeOf } from '../../scheduling';
import { WorkforceEvents } from '../workforce.events';
import { actorView } from '../workforce.shared';

type AssignmentChanged = EventPayload<typeof WorkforceEvents.assignmentChanged>;

/**
 * Assignment offer notices (WRK-04; SPK-COMMS-002 `assignment_offer`, SPK-STAFF-002, IF-22).
 * Communications does not import workforce, so workforce composes its own notices from its own
 * `workforce.assignment_changed`, in the handler's transaction, through
 * `NotificationsService.composeAndQueueIn` with `sourceEventId` = the event id (one notice per
 * event: a replay composes nothing new; the dispatcher's consumption record and the notices'
 * unique source-event key both hold it).
 *
 *  - An assignment moved into `offered` (an offer, or a proposal created as offered): the assignee
 *    is told what is offered, where and when (facility-local time, SPK-SCHED-008), unless the
 *    offer is no longer standing when the handler runs.
 *  - An accepted assignment withdrawn by someone other than the assignee (staff, a replacement, or
 *    a follow-up such as a canceled activity or a retired requirement): the assignee is told.
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
    const offered = p.status === 'offered' && p.previousStatus !== 'offered';
    const withdrawnAccepted = p.status === 'withdrawn' && p.previousStatus === 'accepted';
    if (!offered && !withdrawnAccepted) return;
    const row = await ctx.trx
      .selectFrom('assignments')
      .select(['id', 'status', 'person_id', 'target_title', 'withdrawn_by'])
      .where('organization_id', '=', event.organizationId)
      .where('id', '=', p.assignmentId)
      .executeTakeFirst();
    if (!row) return;
    // An offer already answered or retracted needs no notice; a person's own withdrawal neither.
    if (offered && row.status !== 'offered') return;
    if (withdrawnAccepted && actorView(row.withdrawn_by).personId === row.person_id) return;

    const facility = (
      await this.facilities.describe(event.organizationId, [p.facilityId], ctx.trx)
    ).get(p.facilityId);
    const timezone = facility?.timezone ?? 'UTC';
    const start = new Date(p.scheduledStart);
    const end = new Date(p.scheduledEnd);
    const startDate = localDateOf(timezone, start);
    const endDate = localDateOf(timezone, end);
    const when =
      startDate === endDate
        ? `${startDate} ${localTimeOf(timezone, start)}-${localTimeOf(timezone, end)}`
        : `${startDate} ${localTimeOf(timezone, start)} to ${endDate} ${localTimeOf(timezone, end)}`;
    const role = p.role.replaceAll('_', ' ');
    const place = facility ? ` at ${facility.name}` : '';
    const what = `${role} (slot ${p.slot}) for ${row.target_title}${place}, ${when} (${timezone})`;
    const title = (offered ? `Assignment offered: ${role}` : `Assignment withdrawn: ${role}`).slice(
      0,
      200,
    );
    const body = (
      offered
        ? `You are offered the ${what}. Open your assignments to accept or decline it.`
        : `Your accepted ${what} was withdrawn${p.reason ? `: ${p.reason}` : '.'}`
    ).slice(0, 4000);
    await this.notifications.composeAndQueueIn(
      ctx.trx,
      systemPrincipal(event.organizationId, 'workforce.notices'),
      {
        kind: 'assignment_offer',
        category: 'operational',
        facilityId: p.facilityId,
        subject: { type: 'assignment', id: p.assignmentId },
        audience: { personIds: [p.personId] },
        title,
        body,
        protected: false,
        sourceEventId: event.id,
        correlationId: event.correlationId,
      },
    );
  }
}
