import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  PARTICIPANT_RECENT_SESSIONS,
  PUBLIC_PUBLICATION_STATES,
  errors,
  type ListWaitlistQueueQuery,
  type OfferingAvailability,
  type OfferingAvailabilityList,
  type OfferingEnrollmentSummaries,
  type OfferingEnrollmentSummary,
  type OfferingSuggestion,
  type OfferingSuggestions,
  type OfferingSuggestionsQuery,
  type ParticipantActivities,
  type ParticipantActivitiesQuery,
  type ParticipantActivity,
  type Principal,
  type PublicOffering,
  type RecentSessionAttendance,
  type WaitlistQueueItem,
  type WaitlistQueuePage,
} from '@sportspark/contracts';
import type { Db, WaitlistEntryStatus } from '@sportspark/db';
import { AuthorizationService, CLOCK, DATABASE, type Clock } from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  OfferingsService,
  POLICY_PORT,
  type OfferingLookupPort,
  type OfferingSnapshot,
  type PolicyPort,
} from '../../catalog';
// The port file only (not the entry module's index): entry imports this module, so its index
// would close an import cycle; the token is resolved lazily below, never injected.
import { ATTENDANCE_PORT, type AttendancePort } from '../../entry/entry.ports';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { EnrollmentActions } from '../enrollment.actions';
import { ageOn } from '../eligibility/registration-eligibility';
import {
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  keysetPage,
  organizationOf,
  redactWaitlistEntry,
} from '../enrollment.shared';
import { CatalogSessions } from './catalog-sessions';
import { CustomerScope } from './customer-scope';
import { EnrollmentViews } from './enrollment-views';
import { EnrollmentFacilityScope } from './facility-scope';
import { WaitlistService } from './waitlist.service';

const LIVE_WAITLIST: readonly WaitlistEntryStatus[] = ['waiting', 'offered'];
const SUGGESTION_SCAN_PAGES = 3;

/**
 * Overview reads for the park UI (docs/design/park-ui-redesign.md, "Grow" and "Customer app").
 * All are read-only: no hold, basket, application or other write, so none takes an idempotency
 * key, and none runs inside a command transaction.
 *
 * - `summaries`: per offering, enrollment by age on its reference date, required-form completion
 *   and waitlist counts (SPK-REG-005, SPK-REG-008, SPK-CAT-001), counts only (§4.14).
 * - `waitlistQueue`: waitlist entries across offerings for the registrations home (SPK-REG-008).
 * - `activities`: a participant's enrollments with the attendance of their last sessions
 *   (SPK-REG-003, SPK-ENTRY-005), through entry's ATTENDANCE_PORT when entry is part of the app.
 * - `suggestions`: "picked for <child>" — published offerings whose age band fits the child on
 *   the offering's reference date; age is the only input (no profiling beyond eligibility).
 * - `availability`: live places left of offerings (camp week picker; SPK-REG-005).
 */
@Injectable()
export class EnrollmentOverviewService {
  private readonly logger = new Logger(EnrollmentOverviewService.name);
  private attendancePort: AttendancePort | null | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly scope: EnrollmentFacilityScope,
    private readonly customers: CustomerScope,
    private readonly views: EnrollmentViews,
    private readonly waitlist: WaitlistService,
    private readonly sessions: CatalogSessions,
    private readonly catalogOfferings: OfferingsService,
    private readonly moduleRef: ModuleRef,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Offering enrollment summaries
  // -------------------------------------------------------------------------------------------

  async summaries(
    principal: Principal,
    offeringIds: readonly string[],
  ): Promise<OfferingEnrollmentSummaries> {
    const organizationId = organizationOf(principal);
    const action = EnrollmentActions.readEnrollmentSummary;
    await this.authorization.require(principal, action, {
      type: 'enrollment_summary',
      organizationId,
    });
    // §4.3: each offering is summarized only where the reading role covers its facility.
    const facilities = await this.offerings.facilitiesOfOfferings(organizationId, offeringIds);
    const allowedAt = new Map<string, boolean>();
    for (const facilityId of new Set(facilities.values())) {
      const decision = await this.authorization.decide(principal, action, {
        type: 'enrollment_summary',
        organizationId,
        facilityId,
      });
      allowedAt.set(facilityId, decision.allowed);
    }
    const ids = offeringIds.filter((id) => {
      const facilityId = facilities.get(id);
      return facilityId !== undefined && allowedAt.get(facilityId) === true;
    });
    const unavailableOfferingIds = offeringIds.filter((id) => !ids.includes(id));
    if (ids.length === 0) return { items: [], unavailableOfferingIds };

    const enrollments = await this.db
      .selectFrom('enrollments')
      .select(['offering_id', 'participant_person_id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', ids)
      .where('status', 'in', ['confirmed', 'pending'])
      .execute();
    const waitlist = await this.db
      .selectFrom('waitlist_entries')
      .select(['offering_id', 'status'])
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', ids)
      .where('status', 'in', [...LIVE_WAITLIST])
      .groupBy(['offering_id', 'status'])
      .execute();
    // Dates of birth are read only to count ages and never leave this method (§4.14).
    const birthDates = new Map<string, string | null>();
    for (const personId of new Set(enrollments.map((e) => e.participant_person_id))) {
      const canonical = await this.persons.resolveCanonicalPersonId(organizationId, personId);
      const person = await this.persons.findPerson(organizationId, canonical);
      birthDates.set(personId, person?.dateOfBirth ?? null);
    }

    const now = this.clock.now();
    const items: OfferingEnrollmentSummary[] = [];
    for (const offeringId of ids) {
      const snapshot = await this.offerings.getOffering(organizationId, offeringId, now);
      if (!snapshot) continue;
      const rows = enrollments.filter((e) => e.offering_id === offeringId);
      const referenceDate = snapshot.eligibilityReferenceDate;
      const ages = new Map<number | null, { confirmed: number; pending: number }>();
      for (const row of rows) {
        const birth = birthDates.get(row.participant_person_id) ?? null;
        const age = birth ? ageOn(birth, referenceDate) : null;
        const group = ages.get(age) ?? { confirmed: 0, pending: 0 };
        if (row.status === 'confirmed') group.confirmed += 1;
        else group.pending += 1;
        ages.set(age, group);
      }
      const participants = [...new Set(rows.map((r) => r.participant_person_id))];
      const forms = snapshot.requiredForms;
      const acknowledged = new Map<string, number>();
      for (const form of forms) {
        if (participants.length === 0) break;
        for (const subject of await this.policies.acknowledgedSubjects(
          organizationId,
          participants,
          form.id,
        )) {
          acknowledged.set(subject, (acknowledged.get(subject) ?? 0) + 1);
        }
      }
      const acknowledgedTotal = [...acknowledged.values()].reduce((n, c) => n + c, 0);
      const needed = forms.length * participants.length;
      const count = (status: WaitlistEntryStatus) =>
        Number(
          waitlist.find((w) => w.offering_id === offeringId && w.status === status)?.count ?? 0,
        );
      items.push({
        offeringId,
        referenceDate,
        enrolled: {
          confirmed: rows.filter((r) => r.status === 'confirmed').length,
          pending: rows.filter((r) => r.status === 'pending').length,
        },
        byAge: [...ages.entries()]
          .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a - b))
          .map(([ageYears, group]) => ({ ageYears, ...group })),
        forms: {
          requiredFormCount: forms.length,
          participantCount: participants.length,
          participantsComplete: participants.filter(
            (p) => (acknowledged.get(p) ?? 0) >= forms.length,
          ).length,
          percentComplete: needed === 0 ? null : Math.floor((acknowledgedTotal * 100) / needed),
        },
        waitlist: { waiting: count('waiting'), offered: count('offered') },
      });
    }
    return { items, unavailableOfferingIds };
  }

  // -------------------------------------------------------------------------------------------
  // Organization-wide waitlist
  // -------------------------------------------------------------------------------------------

  async waitlistQueue(
    principal: Principal,
    query: ListWaitlistQueueQuery,
  ): Promise<WaitlistQueuePage> {
    const organizationId = organizationOf(principal);
    const action = EnrollmentActions.manageWaitlist;
    // The per-offering list's action (staff only), decided organization-wide, then narrowed to
    // the facilities the managing roles cover (§4.3, §4.14).
    await this.authorization.require(principal, action, {
      type: 'waitlist_entry',
      organizationId,
      facilityId: query.facilityId,
    });
    let scoped = await this.scope.listOfferings(principal, action, organizationId);
    if (query.facilityId) {
      const atFacility = await this.offerings.offeringIdsAtFacilities(organizationId, [
        query.facilityId,
      ]);
      scoped = scoped ? scoped.filter((id) => atFacility.includes(id)) : atFacility;
    }
    if (scoped?.length === 0) {
      return { items: [], nextCursor: null, counts: { waiting: 0, offered: 0 } };
    }
    const statuses = query.status ? [query.status] : [...LIVE_WAITLIST];
    const base = () => {
      let q = this.db
        .selectFrom('waitlist_entries')
        .where('organization_id', '=', organizationId)
        .where('status', 'in', statuses);
      if (scoped) q = q.where('offering_id', 'in', scoped);
      if (query.offeringId) q = q.where('offering_id', '=', query.offeringId);
      if (query.participantPersonId) {
        q = q.where('participant_person_id', '=', query.participantPersonId);
      }
      return q;
    };
    const cursor = decodeCreatedCursor(query.cursor);
    let q = base()
      .selectAll()
      .select(cursorAt('waitlist_entries').as('cursor_at'))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (cursor) q = q.where(beforeCursor('waitlist_entries', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const counted = await base()
      .select(['status'])
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .groupBy('status')
      .execute();
    const viewerFor = await this.scope.viewersByOffering(
      principal,
      EnrollmentActions.readWaitlist,
      organizationId,
      page.rows.map((r) => r.offering_id),
    );
    const now = this.clock.now();
    const snapshots = new Map<string, OfferingSnapshot | null>();
    const items: WaitlistQueueItem[] = [];
    for (const row of page.rows) {
      if (!snapshots.has(row.offering_id)) {
        snapshots.set(
          row.offering_id,
          await this.offerings.getOffering(organizationId, row.offering_id, now),
        );
      }
      const offering = snapshots.get(row.offering_id)?.offering ?? null;
      const entry = redactWaitlistEntry(
        viewerFor(row.offering_id),
        await this.waitlist.view(this.db, organizationId, row),
        row.requested_by_person_id,
      );
      const open = entry.offers.find((o) => o.status === 'offered');
      items.push({
        ...entry,
        offering: offering
          ? {
              id: offering.id,
              name: offering.name,
              kind: offering.kind,
              facilityId: offering.facilityId,
              startsOn: offering.startsOn,
            }
          : null,
        openOffer: open ? { id: open.id, status: open.status, expiresAt: open.expiresAt } : null,
      });
    }
    const count = (status: WaitlistEntryStatus) =>
      Number(counted.find((c) => c.status === status)?.count ?? 0);
    return {
      items,
      nextCursor: page.nextCursor,
      counts: { waiting: count('waiting'), offered: count('offered') },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Participant activities with recent attendance
  // -------------------------------------------------------------------------------------------

  async activities(
    principal: Principal,
    personId: string,
    query: ParticipantActivitiesQuery,
  ): Promise<ParticipantActivities> {
    const organizationId = organizationOf(principal);
    const action = EnrollmentActions.readParticipantActivity;
    // Customer-private (§4.10): staff holding the action, the participant, or a guardian holding
    // view; anyone else gets the answer an unknown person gets.
    await this.authorization.require(principal, action, {
      type: 'participant_activity',
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    const scoped = await this.scope.listOfferings(principal, action, organizationId, personId);
    if (scoped?.length === 0) return { personId, items: [], nextCursor: null };
    // ENT-04, SPK-IAM-007: a survivor's history includes the people merged into it.
    const resolving = await this.persons.personIdsResolvingTo(organizationId, personId);
    const personIds = resolving[0] === personId ? resolving : [personId];
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('enrollments')
      .selectAll()
      .select(cursorAt('enrollments').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', personIds)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (scoped) q = q.where('offering_id', 'in', scoped);
    if (cursor) q = q.where(beforeCursor('enrollments', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    const enrollments = await this.views.views(
      this.db,
      organizationId,
      await this.scope.viewersByOffering(
        principal,
        EnrollmentActions.readEnrollment,
        organizationId,
        page.rows.map((r) => r.offering_id),
      ),
      page.rows,
    );
    const attendance = this.attendance();
    const now = this.clock.now().getTime();
    const sessionsByOffering = new Map<string, Awaited<ReturnType<CatalogSessions['list']>>>();
    const items: ParticipantActivity[] = [];
    for (const enrollment of enrollments) {
      if (!sessionsByOffering.has(enrollment.offeringId)) {
        sessionsByOffering.set(
          enrollment.offeringId,
          await this.sessions.list(organizationId, enrollment.offeringId),
        );
      }
      const started = (sessionsByOffering.get(enrollment.offeringId) ?? [])
        .filter((s) => new Date(s.scheduledStart).getTime() <= now)
        .sort((a, b) => b.scheduledStart.localeCompare(a.scheduledStart))
        .slice(0, PARTICIPANT_RECENT_SESSIONS);
      const recentSessions: RecentSessionAttendance[] = [];
      for (const session of started) {
        let state: RecentSessionAttendance['attendance'] = null;
        let conflict = false;
        if (attendance && session.status !== 'canceled') {
          const observed = (
            await attendance.effectiveAttendance(organizationId, 'session', session.id)
          ).filter((a) => personIds.includes(a.personId));
          conflict = observed.some((a) => a.conflict);
          state = conflict ? null : (observed.find((a) => a.state !== null)?.state ?? null);
        }
        recentSessions.push({
          sessionId: session.id,
          sequence: session.sequence,
          title: session.title,
          scheduledStart: session.scheduledStart,
          scheduledEnd: session.scheduledEnd,
          sessionStatus: session.status,
          attendance: state,
          conflict,
        });
      }
      const held = recentSessions.filter((s) => s.sessionStatus !== 'canceled');
      items.push({
        enrollment,
        recentSessions,
        attendance: attendance
          ? {
              held: held.length,
              attended: held.filter((s) => s.attendance === 'present' || s.attendance === 'late')
                .length,
              recorded: held.filter((s) => s.attendance !== null || s.conflict).length,
            }
          : null,
      });
    }
    return { personId, items, nextCursor: page.nextCursor };
  }

  /** Entry's attendance reader, when the entry module is part of the application. */
  private attendance(): AttendancePort | null {
    if (this.attendancePort !== undefined) return this.attendancePort;
    try {
      this.attendancePort =
        this.moduleRef.get<AttendancePort>(ATTENDANCE_PORT, { strict: false }) ?? null;
    } catch {
      this.attendancePort = null;
    }
    if (!this.attendancePort) {
      this.logger.warn('no attendance reader is part of the application: activities show none');
    }
    return this.attendancePort;
  }

  // -------------------------------------------------------------------------------------------
  // Customer app: suggestions and availability
  // -------------------------------------------------------------------------------------------

  async suggestions(
    principal: Principal,
    query: OfferingSuggestionsQuery,
  ): Promise<OfferingSuggestions> {
    const organizationId = organizationOf(principal);
    // Only for someone the caller may register (the participant themselves or a guardian holding
    // register); anyone else is answered as an unknown person (§4.10).
    const subjects = principal.personId
      ? await this.customers.subjectIds(principal, EnrollmentActions.apply)
      : [];
    if (!subjects.includes(query.participantPersonId)) throw errors.protectedNotFound('person');
    const canonical = await this.persons.resolveCanonicalPersonId(
      organizationId,
      query.participantPersonId,
    );
    const person = await this.persons.findPerson(organizationId, canonical);
    if (!person) throw errors.protectedNotFound('person');
    if (!person.dateOfBirth) {
      return {
        participantPersonId: query.participantPersonId,
        basis: 'date_of_birth_unknown',
        items: [],
      };
    }
    const now = this.clock.now();
    // Already registered or waiting: not suggested again (SPK-REG-008, §4.7 duplicates).
    const personIds = await this.persons.personIdsResolvingTo(organizationId, canonical);
    const ids = personIds.length > 0 ? personIds : [canonical];
    const taken = new Set<string>([
      ...(
        await this.db
          .selectFrom('enrollments')
          .select('offering_id')
          .where('organization_id', '=', organizationId)
          .where('participant_person_id', 'in', ids)
          .where('status', 'in', ['pending', 'confirmed'])
          .execute()
      ).map((r) => r.offering_id),
      ...(
        await this.db
          .selectFrom('waitlist_entries')
          .select('offering_id')
          .where('organization_id', '=', organizationId)
          .where('participant_person_id', 'in', ids)
          .where('status', 'in', [...LIVE_WAITLIST])
          .execute()
      ).map((r) => r.offering_id),
    ]);
    const today = now.toISOString().slice(0, 10);
    const items: OfferingSuggestion[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < SUGGESTION_SCAN_PAGES; pageNo += 1) {
      const page = await this.catalogOfferings.listPublic(principal, {
        view: 'public',
        limit: 100,
        from: today,
        cursor,
      });
      for (const offering of page.items) {
        const suggestion = await this.suggestion(organizationId, offering, person.dateOfBirth, now);
        if (suggestion && !taken.has(offering.id)) items.push(suggestion);
        if (items.length >= query.limit) break;
      }
      if (items.length >= query.limit || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return { participantPersonId: query.participantPersonId, basis: 'ok', items };
  }

  /** The age-band match of one offering, or null (no band, closed to registration, outside it). */
  private async suggestion(
    organizationId: string,
    offering: PublicOffering,
    dateOfBirth: string,
    now: Date,
  ): Promise<OfferingSuggestion | null> {
    const { minAgeYears: min, maxAgeYears: max } = offering.ageBand;
    if (min === undefined && max === undefined) return null;
    if (offering.publicationState === 'registration_paused') return null;
    const snapshot = await this.offerings.getOffering(organizationId, offering.id, now);
    if (!snapshot) return null;
    const ageYears = ageOn(dateOfBirth, snapshot.eligibilityReferenceDate);
    if ((min !== undefined && ageYears < min) || (max !== undefined && ageYears > max)) return null;
    return {
      offering,
      reason: { kind: 'age_band', ageYears, referenceDate: snapshot.eligibilityReferenceDate },
    };
  }

  async availability(
    principal: Principal,
    offeringIds: readonly string[],
  ): Promise<OfferingAvailabilityList> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const visible: string[] = [];
    for (const offeringId of offeringIds) {
      const snapshot = await this.offerings.getOffering(organizationId, offeringId, now);
      if (!snapshot) continue;
      // Published offerings for everyone (discovery data); unpublished ones only for staff who
      // read capacity at the offering's facility.
      if (
        PUBLIC_PUBLICATION_STATES.includes(snapshot.offering.publicationState) ||
        (await this.scope.actsAsStaff(
          principal,
          EnrollmentActions.readCapacity,
          organizationId,
          snapshot.offering.facilityId,
        ))
      ) {
        visible.push(offeringId);
      }
    }
    const pools =
      visible.length > 0
        ? await this.db
            .selectFrom('capacity_pools')
            .select(['offering_id', 'unit', 'capacity', 'committed', 'held'])
            .where('organization_id', '=', organizationId)
            .where('scope_type', '=', 'offering')
            .where('status', '=', 'active')
            .where('offering_id', 'in', visible)
            .orderBy('id')
            .execute()
        : [];
    const items: OfferingAvailability[] = visible.map((offeringId) => {
      const tightest = pools
        .filter((p) => p.offering_id === offeringId)
        .map((p) => ({ ...p, remaining: Math.max(0, p.capacity - p.committed - p.held) }))
        .sort((a, b) => a.remaining - b.remaining)[0];
      if (!tightest) {
        return {
          offeringId,
          status: 'not_configured',
          unit: null,
          capacity: null,
          remaining: null,
        };
      }
      return {
        offeringId,
        status: tightest.remaining > 0 ? 'available' : 'full',
        unit: tightest.unit,
        capacity: tightest.capacity,
        remaining: tightest.remaining,
      };
    });
    return {
      items,
      unavailableOfferingIds: offeringIds.filter((id) => !visible.includes(id)),
    };
  }
}
