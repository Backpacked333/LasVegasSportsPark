import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AvailabilityRequest,
  type CreateAvailabilityRequestInput,
  type ListAvailabilityRequestsQuery,
  type Principal,
} from '@sportspark/contracts';
import { json, type AvailabilityRequestsTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  executorFor,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { iso, organizationOf } from '../competition.shared';
import { availabilityClosed, FixturesService } from './fixtures.service';
import { RosterService } from './roster.service';

function toAvailabilityRequest(row: Selectable<AvailabilityRequestsTable>): AvailabilityRequest {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    teamEntryId: row.team_entry_id,
    requestedByPersonId: row.requested_by_person_id,
    message: row.message,
    requestedAt: iso(row.requested_at),
    recipientCount: row.recipient_count,
  };
}

/**
 * Availability requests (CMP-14; SPK-CAP-001 "request player availability", SPK-CAP-003,
 * SCR-C-24, IF-45). The captain (a co-captain only when the rule set lets one act as captain, the
 * kernel's team authority) or league staff asks the entry's roster players at kickoff who have
 * not answered; a later request for the same fixture is the reminder and reaches only those still
 * without an answer. Each request is an append-only fact; communications delivers one notice per
 * recipient from `competition.availability_requested` (without it the request is recorded and
 * nothing is sent).
 */
@Injectable()
export class AvailabilityRequestsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly fixtures: FixturesService,
    private readonly roster: RosterService,
  ) {}

  async request(
    principal: Principal,
    fixtureId: string,
    input: CreateAvailabilityRequestInput,
    correlationId: string | null,
  ): Promise<AvailabilityRequest> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const fixture = await this.fixtures.loadFixture(trx, organizationId, fixtureId, {
        forUpdate: true,
      });
      if (!fixture) throw errors.protectedNotFound('fixture');
      if (
        input.teamEntryId !== fixture.home_entry_id &&
        input.teamEntryId !== fixture.away_entry_id
      ) {
        throw errors.protectedNotFound('fixture');
      }
      await this.authorization.require(principal, CompetitionActions.requestAvailability, {
        type: 'fixture',
        id: fixtureId,
        organizationId,
        teamEntryId: input.teamEntryId,
        protected: true,
      });
      if (
        fixture.status !== 'scheduled' ||
        !fixture.scheduled_start ||
        now.getTime() >= new Date(fixture.scheduled_start).getTime()
      ) {
        throw availabilityClosed(fixture);
      }
      const kickoff = new Date(fixture.scheduled_start);
      const members = await this.roster.effectiveRoster(
        organizationId,
        input.teamEntryId,
        kickoff,
        trx,
      );
      const personIds = [...new Set(members.map((m) => m.personId))];
      const answered =
        personIds.length === 0
          ? []
          : await trx
              .selectFrom('availability_responses')
              .select('person_id')
              .where('organization_id', '=', organizationId)
              .where('fixture_id', '=', fixtureId)
              .where('person_id', 'in', personIds)
              .where('state', '<>', 'no_response')
              .execute();
      const answeredIds = new Set(answered.map((r) => r.person_id));
      const recipientPersonIds = personIds.filter((id) => !answeredIds.has(id)).sort();
      const earlier = await trx
        .selectFrom('availability_requests')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('organization_id', '=', organizationId)
        .where('fixture_id', '=', fixtureId)
        .where('team_entry_id', '=', input.teamEntryId)
        .executeTakeFirstOrThrow();
      const id = newId();
      const row = await trx
        .insertInto('availability_requests')
        .values({
          id,
          organization_id: organizationId,
          fixture_id: fixtureId,
          team_entry_id: input.teamEntryId,
          requested_by: json(snapshotActor(principal)),
          requested_by_person_id: principal.personId,
          message: input.message ?? null,
          requested_at: now,
          recipient_count: recipientPersonIds.length,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.requestAvailability.id,
        targetType: 'availability_request',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          fixtureId,
          teamEntryId: input.teamEntryId,
          recipientPersonIds,
          reminder: Number(earlier.n) > 0,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.availabilityRequested, {
        organizationId,
        aggregateType: 'fixture',
        aggregateId: fixtureId,
        payload: {
          requestId: id,
          fixtureId,
          teamEntryId: input.teamEntryId,
          recipientPersonIds,
          scheduledStart: kickoff.toISOString(),
          facilityId: fixture.venue_facility_id ?? null,
        },
        correlationId,
      });
      return toAvailabilityRequest(row);
    });
  }

  /** Earlier requests of the fixture for the sides the caller captains (or every side for staff). */
  async list(
    principal: Principal,
    fixtureId: string,
    query: ListAvailabilityRequestsQuery,
  ): Promise<AvailabilityRequest[]> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const fixture = await this.fixtures.loadFixture(db, organizationId, fixtureId);
    if (!fixture) throw errors.protectedNotFound('fixture');
    const sides = [fixture.home_entry_id, fixture.away_entry_id].filter(
      (id): id is string => id !== null && (!query.teamEntryId || id === query.teamEntryId),
    );
    const visible: string[] = [];
    for (const teamEntryId of sides) {
      const decision = await this.authorization.decide(
        principal,
        CompetitionActions.readAvailabilityRequests,
        { type: 'fixture', id: fixtureId, organizationId, teamEntryId, protected: true },
      );
      if (decision.allowed) visible.push(teamEntryId);
    }
    if (visible.length === 0) throw errors.protectedNotFound('fixture');
    const rows = await db
      .selectFrom('availability_requests')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('team_entry_id', 'in', visible)
      .orderBy('requested_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toAvailabilityRequest);
  }
}
