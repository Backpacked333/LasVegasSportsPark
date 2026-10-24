import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  systemPrincipal,
  type AssignmentTargetType,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { DATABASE, type Trx } from '../../../kernel';
import { OfferingsService, SessionsService } from '../../catalog';
import {
  FIXTURE_PORT,
  TEAM_ENTRY_QUERY_PORT,
  type FixturePort,
  type TeamEntryQueryPort,
} from '../../competition';
import { EventsService } from '../../scheduling';

export interface TargetRef {
  targetType: AssignmentTargetType;
  targetId: string;
  offeringId?: string | null;
}

export interface TargetParticipant {
  side: 'home' | 'away' | null;
  teamEntryId: string | null;
  name: string;
}

/** What an assignment needs to know about the activity it covers, read from the owning module. */
export interface ResolvedTarget {
  targetType: AssignmentTargetType;
  targetId: string;
  facilityId: string;
  timezone: string;
  facilitySettings: Record<string, unknown>;
  title: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  schedulingEventId: string | null;
  fixtureId: string | null;
  offeringSessionId: string | null;
  offeringId: string | null;
}

export interface FacilityFacts {
  id: string;
  timezone: string;
  settings: Record<string, unknown>;
}

const notScheduled = (targetType: string, detail: string) =>
  errors.validation(`The ${targetType} has no usable time: ${detail}.`, {
    code: 'target_not_scheduled',
  });

/**
 * Resolves assignment targets through the owning modules' exported services and ports (§4.2):
 * competition fixtures (FIXTURE_PORT), scheduling events (EventsService) and catalog offering
 * sessions (SessionsService). It never reads their tables. The lookups use the organization's
 * system principal after the caller's command has been scoped to that organization; they must run
 * outside a UnitOfWork transaction because the owning services read through the root database.
 */
@Injectable()
export class TargetResolver {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(FIXTURE_PORT) private readonly fixtures: FixturePort,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly entries: TeamEntryQueryPort,
    private readonly events: EventsService,
    private readonly sessions: SessionsService,
    private readonly offerings: OfferingsService,
  ) {}

  async facility(db: Db | Trx, organizationId: string, facilityId: string): Promise<FacilityFacts> {
    const row = await db
      .selectFrom('facilities')
      .select(['id', 'timezone', 'settings'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!row) throw errors.notFound('facility', facilityId);
    return { id: row.id, timezone: row.timezone, settings: row.settings };
  }

  async resolve(organizationId: string, ref: TargetRef): Promise<ResolvedTarget> {
    switch (ref.targetType) {
      case 'fixture':
        return this.resolveFixture(organizationId, ref.targetId);
      case 'event':
        return this.resolveEvent(organizationId, ref.targetId);
      case 'session':
        if (!ref.offeringId) {
          throw errors.validation('offeringId is required for a session target.');
        }
        return this.resolveSession(organizationId, ref.offeringId, ref.targetId);
    }
  }

  /** Team names of a fixture (the only participant information the workspace shows, SPK-UX-007). */
  async participants(organizationId: string, fixtureId: string): Promise<TargetParticipant[]> {
    const fixture = await this.fixtures.findFixture(organizationId, fixtureId);
    if (!fixture) return [];
    const out: TargetParticipant[] = [];
    const home = await this.entries.findTeamEntry(organizationId, fixture.homeEntryId);
    if (home) out.push({ side: 'home', teamEntryId: home.id, name: home.teamName });
    if (fixture.awayEntryId) {
      const away = await this.entries.findTeamEntry(organizationId, fixture.awayEntryId);
      if (away) out.push({ side: 'away', teamEntryId: away.id, name: away.teamName });
    }
    return out;
  }

  private async resolveFixture(organizationId: string, fixtureId: string): Promise<ResolvedTarget> {
    const fixture = await this.fixtures.findFixture(organizationId, fixtureId);
    if (!fixture) throw errors.notFound('fixture', fixtureId);
    if (['canceled', 'played', 'forfeit', 'abandoned'].includes(fixture.status)) {
      throw notScheduled('fixture', `it is ${fixture.status}`);
    }
    if (
      fixture.status !== 'scheduled' ||
      !fixture.schedulingEventId ||
      !fixture.scheduledStart ||
      !fixture.scheduledEnd
    ) {
      throw notScheduled('fixture', 'schedule it before assigning people');
    }
    const event = await this.events.getEvent(
      systemPrincipal(organizationId, 'workforce.targets'),
      fixture.schedulingEventId,
    );
    const facility = await this.facility(this.db, organizationId, event.facilityId);
    const parts = await this.participants(organizationId, fixtureId);
    const home = parts.find((p) => p.side === 'home')?.name ?? 'Home';
    const away = parts.find((p) => p.side === 'away')?.name ?? 'bye';
    return {
      targetType: 'fixture',
      targetId: fixture.id,
      facilityId: facility.id,
      timezone: facility.timezone,
      facilitySettings: facility.settings,
      title: `${home} v ${away}`.slice(0, 300),
      scheduledStart: new Date(fixture.scheduledStart),
      scheduledEnd: new Date(fixture.scheduledEnd),
      schedulingEventId: fixture.schedulingEventId,
      fixtureId: fixture.id,
      offeringSessionId: null,
      offeringId: null,
    };
  }

  private async resolveEvent(organizationId: string, eventId: string): Promise<ResolvedTarget> {
    const event = await this.events
      .getEvent(systemPrincipal(organizationId, 'workforce.targets'), eventId)
      .catch((error: unknown) => {
        if (DomainError.is(error) && error.code === 'NOT_FOUND') {
          throw errors.notFound('event', eventId);
        }
        throw error;
      });
    if (event.status === 'canceled') throw notScheduled('event', 'it is canceled');
    const facility = await this.facility(this.db, organizationId, event.facilityId);
    return {
      targetType: 'event',
      targetId: event.id,
      facilityId: facility.id,
      timezone: facility.timezone,
      facilitySettings: facility.settings,
      title: event.title.slice(0, 300),
      scheduledStart: new Date(event.scheduledStart),
      scheduledEnd: new Date(event.scheduledEnd),
      schedulingEventId: event.id,
      fixtureId: null,
      offeringSessionId: null,
      offeringId: null,
    };
  }

  private async resolveSession(
    organizationId: string,
    offeringId: string,
    sessionId: string,
  ): Promise<ResolvedTarget> {
    const system = systemPrincipal(organizationId, 'workforce.targets');
    const offering = await this.offerings.get(system, offeringId).catch((error: unknown) => {
      if (DomainError.is(error) && error.code === 'NOT_FOUND') {
        throw errors.notFound('offering', offeringId);
      }
      throw error;
    });
    const sessions = await this.sessions.list(system, offeringId);
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) throw errors.notFound('session', sessionId);
    if (session.status !== 'scheduled') throw notScheduled('session', `it is ${session.status}`);
    const facility = await this.facility(this.db, organizationId, offering.facilityId);
    // Catalog keeps the session's event id without a foreign key; only a real event is linked here.
    let schedulingEventId: string | null = null;
    if (session.schedulingEventId) {
      schedulingEventId = await this.events
        .getEvent(system, session.schedulingEventId)
        .then((event) => event.id)
        .catch((error: unknown) => {
          if (DomainError.is(error) && error.code === 'NOT_FOUND') return null;
          throw error;
        });
    }
    return {
      targetType: 'session',
      targetId: session.id,
      facilityId: facility.id,
      timezone: facility.timezone,
      facilitySettings: facility.settings,
      title: (session.title ?? `${offering.name} (session ${session.sequence})`).slice(0, 300),
      scheduledStart: new Date(session.scheduledStart),
      scheduledEnd: new Date(session.scheduledEnd),
      schedulingEventId,
      fixtureId: null,
      offeringSessionId: session.id,
      offeringId,
    };
  }
}
