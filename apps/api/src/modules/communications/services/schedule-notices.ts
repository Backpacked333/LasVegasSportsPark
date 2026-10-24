import { Injectable } from '@nestjs/common';
import {
  systemPrincipal,
  type DomainEvent,
  type EventDetails,
  type EventPayload,
  type NotificationKindValue,
} from '@sportspark/contracts';
import type { Trx } from '../../../kernel';
import type { EventChanged, SchedulePublished } from '../../scheduling';
import { uniqueStrings } from '../communications.shared';
import { CalendarEntriesService } from './calendar-entries.service';
import { NotificationsService } from './notifications.service';

type EventChangedPayload = EventPayload<typeof EventChanged>;
type SchedulePublishedPayload = EventPayload<typeof SchedulePublished>;

/**
 * Outbox consumers for scheduling facts (SPK-COMMS-002 "schedule publication or change",
 * "cancellation"; SPK-COMMS-005). Each notice carries the old and new practical details, is
 * addressed to the committed parties (their guardians through `receive_messages`) and names the
 * event as its subject so a newer change suppresses an older unsent reminder. Draft events never
 * produce customer notices (SPK-SCHED-005). Every handler is idempotent under replay: the
 * composition is keyed on the source event id.
 */
@Injectable()
export class ScheduleNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly entries: CalendarEntriesService,
  ) {}

  async onEventChanged(trx: Trx, event: DomainEvent<EventChangedPayload>): Promise<void> {
    await this.entries.upsertFromEventChange(trx, event);
    const payload = event.payload;
    const kind = noticeKindFor(payload);
    if (!kind) return;
    const subjectPersonIds = uniqueStrings(
      payload.commitments.filter((c) => c.partyType === 'person').map((c) => c.partyId),
    );
    const teamEntryIds = uniqueStrings(
      payload.commitments.filter((c) => c.partyType === 'team').map((c) => c.partyId),
    );
    if (subjectPersonIds.length === 0 && teamEntryIds.length === 0) return;
    const text = describe(kind, payload);
    await this.notifications.composeAndQueueIn(
      trx,
      systemPrincipal(event.organizationId, 'scheduling.notices'),
      {
        kind,
        category: 'operational',
        facilityId: payload.facilityId,
        subject: { type: 'event', id: payload.eventId },
        audience: { subjectPersonIds, teamEntryIds },
        title: text.title,
        body: text.body,
        ...(payload.before ? { detailsBefore: payload.before } : {}),
        ...(payload.after ? { detailsAfter: payload.after } : {}),
        protected: false,
        sourceEventId: event.id,
        correlationId: event.correlationId,
      },
    );
  }

  /** Staff summary of a publication group: what went out and which obligations remain. */
  async onSchedulePublished(trx: Trx, event: DomainEvent<SchedulePublishedPayload>): Promise<void> {
    const payload = event.payload;
    const obligations =
      payload.remainingObligations.length === 0
        ? 'No fixture obligations remain.'
        : `Remaining obligations: ${payload.remainingObligations
            .map((o) => `${o.code} (${o.owner}${o.deadline ? `, by ${o.deadline}` : ''})`)
            .join('; ')}.`;
    await this.notifications.composeAndQueueIn(
      trx,
      systemPrincipal(event.organizationId, 'scheduling.notices'),
      {
        kind: 'schedule_published',
        category: 'operational',
        facilityId: payload.facilityId,
        subject: { type: 'publication', id: payload.publicationId },
        audience: { staffRoles: ['scheduler', 'league_manager'], facilityId: payload.facilityId },
        title: `Schedule published: ${payload.eventIds.length} event(s)`,
        body: `${payload.changes.length} change(s) were published from draft ${payload.draftId}. ${obligations}`,
        protected: false,
        sourceEventId: event.id,
        correlationId: event.correlationId,
      },
    );
  }
}

export function noticeKindFor(payload: EventChangedPayload): NotificationKindValue | null {
  switch (payload.change) {
    case 'created':
    case 'published':
      return payload.after?.status === 'published' ? 'schedule_published' : null;
    case 'moved':
    case 'resized':
    case 'resource_changed':
    case 'updated':
      return payload.after?.status === 'published' ? 'schedule_changed' : null;
    case 'canceled':
      return payload.before?.status === 'published' ? 'cancellation' : null;
  }
}

export function describe(
  kind: NotificationKindValue,
  payload: EventChangedPayload,
): { title: string; body: string } {
  const after = payload.after;
  const before = payload.before;
  const name = (after ?? before)?.title ?? 'Activity';
  switch (kind) {
    case 'schedule_changed':
      return {
        title: `Schedule changed: ${name}`,
        body: `Was: ${when(before)} at ${where(before)}. Now: ${when(after)} at ${where(after)}.${reasonSuffix(payload.reason)}`,
      };
    case 'cancellation':
      return {
        title: `Canceled: ${name}`,
        body: `${name} on ${when(before)} at ${where(before)} has been canceled.${reasonSuffix(payload.reason)}`,
      };
    default:
      return {
        title: `Scheduled: ${name}`,
        body: `${name} is scheduled for ${when(after)} at ${where(after)}.`,
      };
  }
}

const reasonSuffix = (reason: string | null): string => (reason ? ` Reason: ${reason}` : '');

/** Facility-local wall-clock rendering (SPK-SCHED-008); deterministic for a given zone. */
export function when(details: EventDetails | null): string {
  if (!details) return 'an unknown time';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: details.timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const start = formatter.format(new Date(details.scheduledStart));
  const end = new Intl.DateTimeFormat('en-US', {
    timeZone: details.timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(details.scheduledEnd));
  return `${start} to ${end}`;
}

export function where(details: EventDetails | null): string {
  if (!details || details.resources.length === 0) return 'an unassigned space';
  return details.resources.map((r) => r.name).join(', ');
}
