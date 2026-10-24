import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  systemPrincipal,
  type ActivityDetail,
  type ActivityRef,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { currentTransaction, DATABASE, type Trx } from '../../../kernel';
import { OfferingsService, SessionsService } from '../../catalog';
import { EventsService } from '../../scheduling';

/** What entry needs to know about the activity a record concerns, read from its owning module. */
export interface ResolvedActivity {
  detail: ActivityDetail;
  facilityId: string;
  timezone: string;
  facilitySettings: Record<string, unknown>;
  title: string;
  start: Date;
  end: Date;
  canceled: boolean;
  /** Catalog offering of a session activity. */
  offeringId: string | null;
  /** The scheduling event behind the activity (the event itself, or the session's event). */
  schedulingEventId: string | null;
  /** Forms the participant must have acknowledged (catalog required form policy versions). */
  requiredFormPolicyVersionIds: string[];
  /** For an event that schedules a competition fixture: the fixture id (event source). */
  fixtureId: string | null;
  /** People committed to the event by scheduling (officials, named participants). */
  personCommitments: string[];
}

export interface FacilityFacts {
  id: string;
  timezone: string;
  settings: Record<string, unknown>;
}

export function activityKey(ref: ActivityRef): string {
  return ref.type === 'session'
    ? `session:${ref.offeringId}:${ref.sessionId}`
    : `event:${ref.eventId}`;
}

/** The activity reference of a stored entry record. */
export function refOf(detail: ActivityDetail): ActivityRef {
  if (detail.type === 'session') {
    if (!detail.offeringId || !detail.sessionId) {
      throw errors.internal('a session activity without its offering or session');
    }
    return { type: 'session', offeringId: detail.offeringId, sessionId: detail.sessionId };
  }
  return { type: 'event', eventId: detail.id };
}

/**
 * Resolves activities through the owning modules' exported services (§4.2): catalog offering
 * sessions (OfferingsService, SessionsService) and scheduling events (EventsService). It never
 * reads their tables. Those services read through the root database, so resolution must happen
 * before or after a command's transaction, never inside it (under PGlite a root read inside an
 * open transaction would wait for the only connection); the guard turns that mistake into an
 * immediate error. The organization's system principal is used after the caller's command has
 * been scoped to that organization; cross-organization ids are simply not found.
 */
@Injectable()
export class ActivityResolver {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly offerings: OfferingsService,
    private readonly sessions: SessionsService,
    private readonly events: EventsService,
  ) {}

  async facility(organizationId: string, facilityId: string, trx?: Trx): Promise<FacilityFacts> {
    const row = await (trx ?? currentTransaction() ?? this.db)
      .selectFrom('facilities')
      .select(['id', 'timezone', 'settings'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('facility', facilityId);
    return { id: row.id, timezone: row.timezone, settings: row.settings };
  }

  async resolve(organizationId: string, ref: ActivityRef): Promise<ResolvedActivity> {
    if (currentTransaction()) {
      throw errors.internal('activities must be resolved outside the command transaction');
    }
    return ref.type === 'session'
      ? this.resolveSession(organizationId, ref.offeringId, ref.sessionId)
      : this.resolveEvent(organizationId, ref.eventId);
  }

  /** Resolves each distinct reference once; unresolvable ones map to null. */
  async resolveMany(
    organizationId: string,
    refs: readonly ActivityRef[],
  ): Promise<Map<string, ResolvedActivity | null>> {
    const out = new Map<string, ResolvedActivity | null>();
    for (const ref of refs) {
      const key = activityKey(ref);
      if (out.has(key)) continue;
      try {
        out.set(key, await this.resolve(organizationId, ref));
      } catch (error) {
        if (DomainError.is(error) && error.code === 'NOT_FOUND') out.set(key, null);
        else throw error;
      }
    }
    return out;
  }

  /**
   * The scheduled sessions of an offering that overlap the window at the facility (pass scans list
   * today's sessions for selection, SPK-ENTRY-003). Unknown offerings yield nothing.
   */
  async sessionsInWindow(
    organizationId: string,
    offeringId: string,
    facilityId: string,
    window: { start: Date; end: Date },
  ): Promise<ResolvedActivity[]> {
    if (currentTransaction()) {
      throw errors.internal('activities must be resolved outside the command transaction');
    }
    const system = systemPrincipal(organizationId, 'entry.activities');
    let offering;
    try {
      offering = await this.offerings.get(system, offeringId);
    } catch (error) {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') return [];
      throw error;
    }
    if (offering.facilityId !== facilityId) return [];
    const facility = await this.facility(organizationId, facilityId);
    const sessions = await this.sessions.list(system, offeringId);
    return sessions
      .filter(
        (s) =>
          s.status === 'scheduled' &&
          new Date(s.scheduledStart).getTime() < window.end.getTime() &&
          new Date(s.scheduledEnd).getTime() > window.start.getTime(),
      )
      .map((session) => ({
        detail: {
          type: 'session' as const,
          id: session.id,
          offeringId,
          sessionId: session.id,
          eventId: session.schedulingEventId,
        },
        facilityId: facility.id,
        timezone: facility.timezone,
        facilitySettings: facility.settings,
        title: (session.title ?? `${offering.name} (session ${session.sequence})`).slice(0, 300),
        start: new Date(session.scheduledStart),
        end: new Date(session.scheduledEnd),
        canceled: false,
        offeringId,
        schedulingEventId: session.schedulingEventId,
        requiredFormPolicyVersionIds: [...offering.requiredFormPolicyVersionIds],
        fixtureId: null,
        personCommitments: [],
      }));
  }

  private async resolveSession(
    organizationId: string,
    offeringId: string,
    sessionId: string,
  ): Promise<ResolvedActivity> {
    const system = systemPrincipal(organizationId, 'entry.activities');
    const offering = await this.offerings.get(system, offeringId).catch((error: unknown) => {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') {
        throw errors.notFound('session', sessionId);
      }
      throw error;
    });
    const session = (await this.sessions.list(system, offeringId)).find((s) => s.id === sessionId);
    if (!session) throw errors.notFound('session', sessionId);
    const facility = await this.facility(organizationId, offering.facilityId);
    return {
      detail: {
        type: 'session',
        id: session.id,
        offeringId,
        sessionId: session.id,
        eventId: session.schedulingEventId,
      },
      facilityId: facility.id,
      timezone: facility.timezone,
      facilitySettings: facility.settings,
      title: (session.title ?? `${offering.name} (session ${session.sequence})`).slice(0, 300),
      start: new Date(session.scheduledStart),
      end: new Date(session.scheduledEnd),
      canceled: session.status === 'canceled',
      offeringId,
      schedulingEventId: session.schedulingEventId,
      requiredFormPolicyVersionIds: [...offering.requiredFormPolicyVersionIds],
      fixtureId: null,
      personCommitments: [],
    };
  }

  private async resolveEvent(organizationId: string, eventId: string): Promise<ResolvedActivity> {
    const system = systemPrincipal(organizationId, 'entry.activities');
    const event = await this.events.getEvent(system, eventId).catch((error: unknown) => {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') {
        throw errors.notFound('event', eventId);
      }
      throw error;
    });
    const facility = await this.facility(organizationId, event.facilityId);
    return {
      detail: { type: 'event', id: event.id, offeringId: null, sessionId: null, eventId: event.id },
      facilityId: facility.id,
      timezone: facility.timezone,
      facilitySettings: facility.settings,
      title: event.title.slice(0, 300),
      start: new Date(event.scheduledStart),
      end: new Date(event.scheduledEnd),
      canceled: event.status === 'canceled',
      offeringId: null,
      schedulingEventId: event.id,
      requiredFormPolicyVersionIds: [],
      fixtureId: event.sourceType === 'fixture' && event.sourceId ? event.sourceId : null,
      personCommitments: event.commitments
        .filter((c) => c.partyType === 'person')
        .map((c) => c.partyId),
    };
  }
}
