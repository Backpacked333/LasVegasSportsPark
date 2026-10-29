import type { TestingModuleBuilder } from '@nestjs/testing';
import {
  DomainError,
  errors,
  newId,
  type Event,
  type PolicyVersion,
  type Principal,
} from '@sportspark/contracts';
import type { Db, GrantPermissionValue } from '@sportspark/db';
import { sql } from 'kysely';
import {
  DATABASE,
  FacilityDirectory,
  RELATIONSHIP_AUTHORITY_IMPL,
  UnitOfWork,
  currentTransaction,
  type Trx,
} from '../../../kernel';
import { OFFERING_LOOKUP_PORT, OfferingsService, type OfferingLookupPort } from '../../catalog';
import {
  TEAM_ENTRY_QUERY_PORT,
  TeamEntriesService,
  type TeamEntryQueryPort,
} from '../../competition';
import { PERSON_DIRECTORY_PORT, PeopleService, RelationshipAuthority } from '../../identity';
import {
  EVENT_SCHEDULING_PORT,
  EventsService,
  materializeOccurrences,
  type CreateEventSeriesInput,
  type EventSchedulingPort,
} from '../../scheduling';
import {
  ASSIGNMENT_COVERAGE_PORT,
  CoverageService,
  RequirementsService,
  WORKFORCE_STAFFING_PORT,
  type AssignmentCoveragePort,
  type WorkforceStaffingPort,
} from '../../workforce';

/**
 * Test doubles for stage-3 port members that are declared on the core branch but implemented by
 * other modules' work items (ID-01, ID-04, CMP-01, SCH-02, WRK-02, WRK-03; CAT-02 for booking
 * terms). Each double wraps the module's real provider and answers through the declared contract
 * (IF-09, IF-01/IF-02, IF-15, IF-31, IF-32, IF-34, IF-23) only where the real member is still
 * `declaredNotImplemented`, so once the owning work item is merged these tests exercise the real
 * implementation unchanged. Booking terms are an explicit per-offering override (the catalog's
 * booking-terms vocabulary is CAT-02's): a test names the approved terms it books under.
 * This is test infrastructure only; production code calls the ports as declared.
 */

export function isDeclaredNotImplemented(error: unknown): boolean {
  return (
    DomainError.is(error) &&
    error.code === 'INTERNAL_ERROR' &&
    /declared but not implemented/.test(error.message)
  );
}

async function realOr<T>(real: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await real();
  } catch (error) {
    if (isDeclaredNotImplemented(error)) return fallback();
    throw error;
  }
}

/** Approved booking terms a test books an offering under (offering id → policy version). */
const bookingTermsOverrides = new Map<string, PolicyVersion>();
export function useBookingTerms(offeringId: string, terms: PolicyVersion): void {
  bookingTermsOverrides.set(offeringId, terms);
}

function reader(db: Db, trx?: Trx): Db | Trx {
  return trx ?? currentTransaction() ?? db;
}

/** The overrides, for `createTestApp({ configure })`. */
export function withStage3Doubles(builder: TestingModuleBuilder): TestingModuleBuilder {
  return (
    builder
      // IF-09 (ID-01): names and merged ids.
      .overrideProvider(PERSON_DIRECTORY_PORT)
      .useFactory({
        inject: [PeopleService, DATABASE],
        factory: (people: PeopleService, db: Db) => {
          const port = Object.create(people) as PeopleService;
          port.displayNames = (organizationId, personIds, trx) =>
            realOr(
              () => people.displayNames(organizationId, personIds, trx),
              async () => {
                if (personIds.length === 0) return new Map();
                const rows = await reader(db, trx)
                  .selectFrom('persons')
                  .select(['id', 'given_name', 'family_name', 'kind'])
                  .where('organization_id', '=', organizationId)
                  .where('id', 'in', [...personIds])
                  .execute();
                return new Map(
                  rows.map((r) => [
                    r.id,
                    {
                      personId: r.id,
                      givenName: r.given_name,
                      familyName: r.family_name,
                      displayName: `${r.given_name} ${r.family_name}`,
                      kind: r.kind,
                    },
                  ]),
                );
              },
            );
          port.personIdsResolvingTo = (organizationId, personId, trx) =>
            realOr(
              () => people.personIdsResolvingTo(organizationId, personId, trx),
              async () => {
                if (!(await people.findPerson(organizationId, personId, trx))) return [];
                const canonical = await people.resolveCanonicalPersonId(
                  organizationId,
                  personId,
                  trx,
                );
                const merged = await reader(db, trx)
                  .selectFrom('persons')
                  .select('id')
                  .where('organization_id', '=', organizationId)
                  .where('merged_into_person_id', 'is not', null)
                  .execute();
                const ids = [canonical];
                for (const row of merged) {
                  if (
                    (await people.resolveCanonicalPersonId(organizationId, row.id, trx)) ===
                    canonical
                  ) {
                    ids.push(row.id);
                  }
                }
                return [canonical, ...ids.slice(1).sort()];
              },
            );
          return port;
        },
      })
      // IF-01 / IF-02 (ID-04): the subjects the actor holds a permission over. The core default
      // answers []; the double adds the actor's effective authorities (the same effectivity rule).
      .overrideProvider(RELATIONSHIP_AUTHORITY_IMPL)
      .useFactory({
        inject: [RelationshipAuthority],
        factory: (authority: RelationshipAuthority) => {
          const port = Object.create(authority) as RelationshipAuthority;
          port.subjectsWithPermission = async (
            organizationId: string,
            actorPersonId: string,
            permission: GrantPermissionValue,
          ) => {
            const real = await authority.subjectsWithPermission(
              organizationId,
              actorPersonId,
              permission,
            );
            const held = (await authority.authoritiesOf(organizationId, actorPersonId))
              .filter((a) => a.permissions.includes(permission))
              .map((a) => a.subjectPersonId);
            return [...new Set([...real, ...held])].sort();
          };
          return port;
        },
      })
      // IF-15 (CMP-01): the season whose registration window is the offering.
      .overrideProvider(TEAM_ENTRY_QUERY_PORT)
      .useFactory({
        inject: [TeamEntriesService, DATABASE],
        factory: (entries: TeamEntriesService, db: Db): TeamEntryQueryPort => {
          const port = Object.create(entries) as TeamEntriesService;
          port.seasonForOffering = (organizationId, offeringId, trx) =>
            realOr(
              () => entries.seasonForOffering(organizationId, offeringId, trx),
              async () => {
                const row = await reader(db, trx)
                  .selectFrom('seasons')
                  .select(['id', 'competition_id'])
                  .where('organization_id', '=', organizationId)
                  .where('registration_offering_ref', '=', offeringId)
                  .orderBy('id')
                  .executeTakeFirst();
                return row ? { seasonId: row.id, competitionId: row.competition_id } : null;
              },
            );
          return port;
        },
      })
      // IF-23 (CAT-02): the approved booking terms a test named for the offering.
      .overrideProvider(OFFERING_LOOKUP_PORT)
      .useFactory({
        inject: [OfferingsService],
        factory: (offerings: OfferingsService): OfferingLookupPort => {
          const port = Object.create(offerings) as OfferingsService;
          port.getOffering = async (organizationId, offeringId, at, trx) => {
            const snapshot = await offerings.getOffering(organizationId, offeringId, at, trx);
            const terms = bookingTermsOverrides.get(offeringId);
            return snapshot && terms ? { ...snapshot, bookingTerms: terms } : snapshot;
          };
          return port;
        },
      })
      // IF-31 (SCH-02): a weekly series as its occurrences, every conflict reported first.
      .overrideProvider(EVENT_SCHEDULING_PORT)
      .useFactory({
        inject: [EventsService, UnitOfWork, FacilityDirectory],
        factory: (
          events: EventsService,
          uow: UnitOfWork,
          facilities: FacilityDirectory,
        ): EventSchedulingPort => {
          const port = Object.create(events) as EventsService;
          const series = new Map<string, string[]>();
          port.createEventSeries = (principal: Principal, input: CreateEventSeriesInput) =>
            realOr(
              () => events.createEventSeries(principal, input),
              () =>
                uow.run(async () => {
                  const zone = (
                    await facilities.describe(principal.organizationId as string, [
                      input.facilityId,
                    ])
                  ).get(input.facilityId)?.timezone;
                  if (!zone) throw errors.notFound('facility', input.facilityId);
                  const occurrences = materializeOccurrences(
                    { ...input.recurrence, interval: input.recurrence.interval ?? 1 },
                    {
                      localStartTime: input.localStartTime,
                      durationMinutes: input.durationMinutes,
                      timezone: zone,
                      maxOccurrences: 366,
                    },
                  );
                  const created: Event[] = [];
                  const conflicts: Array<{
                    occurrenceStart: string;
                    conflictingEventIds: string[];
                  }> = [];
                  for (const occurrence of occurrences) {
                    try {
                      created.push(
                        await events.createEvent(principal, {
                          kind: input.kind,
                          title: input.title,
                          facilityId: input.facilityId,
                          scheduledStart: occurrence.start.toISOString(),
                          scheduledEnd: occurrence.end.toISOString(),
                          resourceIds: input.resourceIds,
                          setupMinutes: input.setupMinutes,
                          cleanupMinutes: input.cleanupMinutes,
                          commitments: input.commitments,
                          sourceType: input.sourceType,
                          sourceId: input.sourceId,
                          correlationId: input.correlationId ?? null,
                        }),
                      );
                    } catch (error) {
                      if (!DomainError.is(error) || error.code !== 'RESOURCE_CONFLICT') throw error;
                      const details = (error.details ?? {}) as {
                        conflicts?: Array<{ eventId?: string }>;
                      };
                      conflicts.push({
                        occurrenceStart: occurrence.start.toISOString(),
                        conflictingEventIds: (details.conflicts ?? [])
                          .map((c) => c.eventId)
                          .filter((id): id is string => !!id),
                      });
                    }
                  }
                  if (conflicts.length > 0) {
                    throw errors.resourceConflict(
                      'The series conflicts with existing reservations.',
                      {
                        conflicts,
                      },
                    );
                  }
                  const seriesId = newId();
                  series.set(
                    seriesId,
                    created.map((e) => e.id),
                  );
                  return { seriesId, eventIds: created.map((e) => e.id) };
                }),
            );
          port.cancelEventSeries = (principal, seriesId, input) =>
            realOr(
              () => events.cancelEventSeries(principal, seriesId, input),
              async () => {
                const canceledEventIds: string[] = [];
                for (const eventId of series.get(seriesId) ?? []) {
                  const event = await events.getEvent(principal, eventId);
                  if (event.status === 'canceled') continue;
                  await events.cancelEvent(principal, eventId, { reason: input.reason });
                  canceledEventIds.push(eventId);
                }
                return { canceledEventIds };
              },
            );
          return port;
        },
      })
      // IF-32 (WRK-02): must-be-accepted requirements on booking events.
      .overrideProvider(WORKFORCE_STAFFING_PORT)
      .useFactory({
        inject: [RequirementsService, DATABASE],
        factory: (requirements: RequirementsService, db: Db): WorkforceStaffingPort => ({
          declareRequirements: async (principal, input) => {
            const ids: string[] = [];
            for (const requirement of input.requirements) {
              try {
                const created = await requirements.create(
                  principal,
                  {
                    targetType: 'event',
                    targetId: input.targetId,
                    kind: requirement.kind,
                    role: requirement.role,
                    requiredCount: requirement.requiredCount,
                    mustBeAccepted: true,
                    requiredQualifications: requirement.requiredQualifications,
                  },
                  null,
                );
                ids.push(created.id);
              } catch (error) {
                if (!DomainError.is(error) || error.code !== 'RESOURCE_CONFLICT') throw error;
              }
            }
            return { requirementIds: ids };
          },
          withdrawRequirements: async (_principal, input) => {
            // The double records the withdrawal by zeroing nothing (WRK-02 retires them); it
            // reports which requirements the event had.
            const rows = await reader(db)
              .selectFrom('assignment_requirements')
              .select('id')
              .where('target_type', '=', 'event')
              .where('target_id', '=', input.targetId)
              .execute();
            return { withdrawnAssignmentIds: [], retiredRequirementIds: rows.map((r) => r.id) };
          },
        }),
      })
      // IF-34 (WRK-03): an accepted or completed assignment on any session of the offering.
      .overrideProvider(ASSIGNMENT_COVERAGE_PORT)
      .useFactory({
        inject: [CoverageService, DATABASE],
        factory: (coverage: CoverageService, db: Db): AssignmentCoveragePort => {
          const port = Object.create(coverage) as CoverageService;
          port.isAcceptedOnOffering = (organizationId, offeringId, personId, kind, trx) =>
            realOr(
              () => coverage.isAcceptedOnOffering(organizationId, offeringId, personId, kind, trx),
              async () => {
                const sessions = await reader(db, trx)
                  .selectFrom('offering_sessions')
                  .select('id')
                  .where('organization_id', '=', organizationId)
                  .where('offering_id', '=', offeringId)
                  .execute();
                for (const session of sessions) {
                  const accepted = await coverage.acceptedAssignees(
                    organizationId,
                    'session',
                    session.id,
                    kind,
                    trx,
                  );
                  if (accepted.includes(personId)) return true;
                }
                return false;
              },
            );
          return port;
        },
      })
  );
}

/** `sql` re-export so specs can run raw reads without importing kysely themselves. */
export { sql };
