import { Inject, Injectable, Logger } from '@nestjs/common';
import { systemPrincipal, z, type EventDetails } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  DATABASE,
  MODULE_SETTINGS,
  UnitOfWork,
  defineModuleSettings,
  policySetting,
  type ModuleSettingsOf,
  type PeriodicJob,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import { SESSION_AUDIENCE_PORT, type SessionAudiencePort } from '../ports';
import { uniqueStrings } from '../communications.shared';
import { NotificationsService } from './notifications.service';
import { when, where } from './schedule-notices';

/**
 * Communications settings (K-15, IF-43). `ACTIVITY_REMINDER_LEAD_MINUTES`
 * (`COMMUNICATIONS_ACTIVITY_REMINDER_LEAD_MINUTES`) is the communication policy's reminder lead
 * time: a policy value with no default (DEC-012 pending). Unset, no activity reminder is composed.
 */
export const CommunicationsSettings = defineModuleSettings('communications', {
  ACTIVITY_REMINDER_LEAD_MINUTES: policySetting(z.coerce.number().int().min(1).max(20160)),
});
export type CommunicationsSettingsValue = ModuleSettingsOf<typeof CommunicationsSettings>;

export const COMPOSE_ACTIVITY_REMINDERS_JOB = 'communications.compose_activity_reminders';

interface DueEntry {
  id: string;
  organization_id: string;
  event_id: string;
  source_revision: number;
  facility_id: string;
  title: string;
  kind: string;
  scheduled_start: Date | string;
  scheduled_end: Date | string;
  timezone: string;
  resources: Array<{ id: string; name: string }>;
}

/**
 * `communications.compose_activity_reminders` (COM-06; SPK-CAP-001 "remind", SPK-COMMS-002,
 * SPK-COMMS-005, K-06 periodic job, failure owner support). Acts only when the reminder lead time
 * is configured (DEC-012): for each published event of this module's calendar projection that
 * starts within the lead time, one `activity_reminder` per (event, revision) to the audience the
 * event's schedule notices resolve (committed persons and teams, and the participants of the
 * catalog sessions behind it). The reminder mark is inserted in the same small transaction as the
 * notice, so a replayed pass or a second worker composes nothing, and a moved event (a new
 * revision) is reminded again with its new details; an unsent reminder about an event that then
 * changes is superseded like any schedule notice (SPK-COMMS-005). Entries projected before the
 * event revision was recorded (migration 1002) are skipped until their next change.
 */
@Injectable()
export class ActivityReminders {
  private readonly logger = new Logger(ActivityReminders.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(MODULE_SETTINGS('communications'))
    private readonly settings: CommunicationsSettingsValue,
    @Inject(SESSION_AUDIENCE_PORT) private readonly sessionAudience: SessionAudiencePort,
    private readonly uow: UnitOfWork,
    private readonly notifications: NotificationsService,
  ) {}

  job(): PeriodicJob {
    return {
      name: COMPOSE_ACTIVITY_REMINDERS_JOB,
      intervalSeconds: 300,
      failureOwner: 'support_operator',
      run: (context) => this.run(context),
    };
  }

  async run({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const lead = this.settings.ACTIVITY_REMINDER_LEAD_MINUTES;
    if (lead === undefined) return { processed: 0, remaining: 0 };
    const until = new Date(now.getTime() + lead * 60_000);
    const due = await this.dueEntries(this.db, now, until, batchSize + 1);
    let processed = 0;
    for (const entry of due.slice(0, batchSize)) {
      if (await this.remind(entry, now, until)) processed += 1;
    }
    return { processed, remaining: Math.max(0, due.length - batchSize) };
  }

  private dueEntries(db: Db, now: Date, until: Date, limit: number): Promise<DueEntry[]> {
    return db
      .selectFrom('calendar_entries as e')
      .select([
        'e.id',
        'e.organization_id',
        'e.event_id',
        'e.facility_id',
        'e.title',
        'e.kind',
        'e.scheduled_start',
        'e.scheduled_end',
        'e.timezone',
        'e.resources',
        sql<number>`e.source_revision`.as('source_revision'),
      ])
      .where('e.status', '=', 'published')
      .where('e.source_revision', 'is not', null)
      .where('e.scheduled_start', '>', now)
      .where('e.scheduled_start', '<=', until)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('reminder_marks as m')
              .select('m.event_revision')
              .whereRef('m.organization_id', '=', 'e.organization_id')
              .whereRef('m.scheduling_event_id', '=', 'e.event_id')
              .whereRef('m.event_revision', '=', 'e.source_revision'),
          ),
        ),
      )
      .orderBy('e.scheduled_start')
      .orderBy('e.id')
      .limit(limit)
      .execute() as Promise<DueEntry[]>;
  }

  /** One small transaction per entry: lock it, claim its mark, compose the reminder. */
  private async remind(candidate: DueEntry, now: Date, until: Date): Promise<boolean> {
    return this.uow.run(async ({ trx }) => {
      const entry = (await trx
        .selectFrom('calendar_entries')
        .select([
          'id',
          'organization_id',
          'event_id',
          'facility_id',
          'title',
          'kind',
          'scheduled_start',
          'scheduled_end',
          'timezone',
          'resources',
          sql<number>`source_revision`.as('source_revision'),
        ])
        .where('id', '=', candidate.id)
        .where('status', '=', 'published')
        .where('source_revision', '=', candidate.source_revision)
        .where('scheduled_start', '>', now)
        .where('scheduled_start', '<=', until)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()) as DueEntry | undefined;
      if (!entry) return false; // changed since it was read, or another worker holds it
      const marked = await trx
        .insertInto('reminder_marks')
        .values({
          organization_id: entry.organization_id,
          scheduling_event_id: entry.event_id,
          event_revision: entry.source_revision,
          composed_at: now,
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'scheduling_event_id', 'event_revision']).doNothing(),
        )
        .returning('event_revision')
        .executeTakeFirst();
      if (!marked) return false; // reminded already (a replay or a second worker)
      const parties = await trx
        .selectFrom('calendar_entry_parties')
        .select(['party_type', 'party_id'])
        .where('organization_id', '=', entry.organization_id)
        .where('entry_id', '=', entry.id)
        .execute();
      const participants = await this.sessionAudience.participantsOfSchedulingEvent(
        trx,
        entry.organization_id,
        entry.event_id,
      );
      const subjectPersonIds = uniqueStrings([
        ...parties.filter((p) => p.party_type === 'person').map((p) => p.party_id),
        ...participants,
      ]);
      const teamEntryIds = uniqueStrings(
        parties.filter((p) => p.party_type === 'team').map((p) => p.party_id),
      );
      if (subjectPersonIds.length === 0 && teamEntryIds.length === 0) return true; // nobody to tell
      const details: EventDetails = {
        title: entry.title,
        kind: entry.kind,
        scheduledStart: new Date(entry.scheduled_start).toISOString(),
        scheduledEnd: new Date(entry.scheduled_end).toISOString(),
        timezone: entry.timezone,
        facilityId: entry.facility_id,
        resources: entry.resources,
        status: 'published',
      } as EventDetails;
      await this.notifications.composeAndQueueIn(
        trx,
        systemPrincipal(entry.organization_id, COMPOSE_ACTIVITY_REMINDERS_JOB),
        {
          kind: 'activity_reminder',
          category: 'operational',
          facilityId: entry.facility_id,
          subject: { type: 'event', id: entry.event_id },
          audience: { subjectPersonIds, teamEntryIds },
          title: `Reminder: ${entry.title}`,
          body: `${entry.title} is on ${when(details)} at ${where(details)}.`,
          detailsAfter: { ...details, revision: entry.source_revision },
          // Who is enrolled is customer-private: re-checked before dispatch (§4.7 invariant 10).
          protected: participants.length > 0,
        },
      );
      this.logger.debug(`reminded event ${entry.event_id} revision ${entry.source_revision}`);
      return true;
    });
  }
}
