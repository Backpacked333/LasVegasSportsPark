import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type IssuedPass,
  type IssuePassBody,
  type MyPass,
  type Pass,
  type PassScan,
  type Principal,
  type RevokePassBody,
  type ScanActivity,
  type ScanPassBody,
  type ScanPerson,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  ensureUpdated,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { ENROLLMENT_PORT, type EnrollmentPort } from '../../enrollment';
import {
  AUTHORITY_LOOKUP_PORT,
  HouseholdsService,
  PeopleService,
  PERSON_DIRECTORY_PORT,
  RelationshipAuthority,
  type AuthorityLookupPort,
  type PersonDirectoryPort,
} from '../../identity';
import { EntryActions } from '../entry.actions';
import { EntryEvents } from '../entry.events';
import {
  audienceOf,
  hashPassReference,
  localDayWindow,
  newPassReference,
  organizationOf,
  toMyPass,
  toPass,
  type PassRow,
} from '../entry.shared';
import { PassMachine } from '../entry.state-machines';
import { ActivityResolver, type ResolvedActivity } from './activity-resolver';

interface ScanCandidate {
  personId: string;
  relation: ScanPerson['relation'];
}

/**
 * Passes (SPK-ENTRY-002, SPK-ENTRY-003). A pass is an opaque random reference for a person or a
 * household; only its SHA-256 is stored and the reference is returned once, at issue. Scanning
 * resolves the holder's people and their sessions today at the facility so staff can select who
 * actually arrived — the scan itself records nobody as present (SPK-AT-015).
 */
@Injectable()
export class PassesService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly directory: PersonDirectoryPort,
    @Inject(AUTHORITY_LOOKUP_PORT) private readonly authority: AuthorityLookupPort,
    @Inject(ENROLLMENT_PORT) private readonly enrollments: EnrollmentPort,
    private readonly people: PeopleService,
    private readonly households: HouseholdsService,
    private readonly relationships: RelationshipAuthority,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly resolver: ActivityResolver,
  ) {}

  async issue(
    principal: Principal,
    body: IssuePassBody,
    correlationId: string | null,
  ): Promise<IssuedPass> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      if (body.holder.kind === 'person') {
        const person = await this.directory.findPerson(organizationId, body.holder.personId, trx);
        if (!person || person.status !== 'active') throw errors.protectedNotFound('person');
        await this.authorization.require(principal, EntryActions.issuePass, {
          type: 'pass',
          organizationId,
          subjectPersonIds: [body.holder.personId],
          protected: true,
        });
      } else {
        // Household passes are issued by staff only; a customer learns nothing about the household.
        await this.authorization.require(principal, EntryActions.issuePass, {
          type: 'pass',
          organizationId,
          protected: true,
        });
        await this.households.detail(trx, organizationId, body.holder.householdId);
      }
      const reference = newPassReference();
      const now = this.clock.now();
      const row = await trx
        .insertInto('passes')
        .values({
          id: newId(),
          organization_id: organizationId,
          holder_kind: body.holder.kind,
          holder_person_id: body.holder.kind === 'person' ? body.holder.personId : null,
          holder_household_id: body.holder.kind === 'household' ? body.holder.householdId : null,
          reference_hash: hashPassReference(reference),
          issued_at: now,
          issued_by: json(snapshotActor(principal)),
          issued_by_person_id: principal.personId,
          revoked_at: null,
          revoked_by: null,
          revoked_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.issuePass.id,
        targetType: 'pass',
        targetId: row.id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: { holderKind: row.holder_kind },
      });
      await this.outbox.enqueue(trx, EntryEvents.passIssued, {
        organizationId,
        aggregateType: 'pass',
        aggregateId: row.id,
        payload: { passId: row.id, holderKind: row.holder_kind },
        correlationId,
      });
      return { pass: toPass(row), reference };
    });
  }

  async revoke(
    principal: Principal,
    id: string,
    body: RevokePassBody,
    correlationId: string | null,
  ): Promise<Pass> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const pass = await this.load(trx, organizationId, id);
      if (!pass) throw errors.protectedNotFound('pass');
      await this.authorization.require(principal, EntryActions.revokePass, {
        type: 'pass',
        id,
        organizationId,
        subjectPersonIds: pass.holder_person_id ? [pass.holder_person_id] : undefined,
        protected: true,
      });
      assertExpectedRevision(body.expectedRevision, pass.revision);
      const status = PassMachine.next(pass.status, 'revoke');
      const result = await trx
        .updateTable('passes')
        .set({
          status,
          revoked_at: this.clock.now(),
          revoked_by: json(snapshotActor(principal)),
          revoked_reason: body.reason,
          revision: pass.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', pass.revision)
        .executeTakeFirst();
      ensureUpdated(result.numUpdatedRows, () =>
        errors.staleRevision(body.expectedRevision, pass.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.revokePass.id,
        targetType: 'pass',
        targetId: id,
        beforeRevision: pass.revision,
        afterRevision: pass.revision + 1,
        reason: body.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, EntryEvents.passRevoked, {
        organizationId,
        aggregateType: 'pass',
        aggregateId: id,
        payload: { passId: id },
        correlationId,
      });
      const updated = await this.load(trx, organizationId, id);
      if (!updated) throw errors.protectedNotFound('pass');
      return toPass(updated);
    });
  }

  /**
   * GET /v1/me/passes (ENT-01, SPK-ENTRY-002, SCR-C-05): the person passes the caller holds,
   * newest first, including passes issued to people merged into them (ENT-04, SPK-IAM-007: the
   * pass keeps its original holder id). The reference is never returned: only its hash is stored,
   * so a holder who lost it revokes the pass and issues a new one. A revocation by staff shows as
   * `revoked` with its time; the staff reason is withheld from customers (§4.14). Household passes
   * are staff-managed and not listed (a customer learns nothing about the household).
   */
  async mine(principal: Principal): Promise<MyPass[]> {
    const organizationId = organizationOf(principal);
    const personId = principal.personId;
    if (!personId) return [];
    const decision = await this.authorization.decide(principal, EntryActions.readPass, {
      type: 'pass',
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    if (!decision.allowed) return [];
    const resolving = await this.directory.personIdsResolvingTo(organizationId, personId);
    // Only the canonical person reads the passes of people merged into them.
    const holders = resolving[0] === personId ? resolving : [personId];
    const rows = await this.uow
      .reader()
      .selectFrom('passes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('holder_kind', '=', 'person')
      .where('holder_person_id', 'in', holders)
      .orderBy('issued_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const audience = audienceOf(decision.basis);
    return rows.map((row) => toMyPass(row, audience));
  }

  /**
   * SPK-ENTRY-002/003: opens the selection flow. Authorization comes first, so a caller without the
   * desk role learns nothing about whether a reference exists. Nothing is written except the audit
   * record of the scan.
   */
  async scan(
    principal: Principal,
    body: ScanPassBody,
    correlationId: string | null,
  ): Promise<PassScan> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EntryActions.scanPass, {
      type: 'facility',
      id: body.facilityId,
      organizationId,
      facilityId: body.facilityId,
    });
    const facility = await this.resolver.facility(organizationId, body.facilityId);
    const db = this.uow.reader();
    const pass = await db
      .selectFrom('passes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('reference_hash', '=', hashPassReference(body.reference))
      .executeTakeFirst();
    if (!pass) throw errors.notFound('pass');
    if (pass.status !== 'active') {
      throw errors.resourceConflict('This pass has been revoked.', {
        code: 'pass_revoked',
        passId: pass.id,
      });
    }
    const now = this.clock.now();
    const window = localDayWindow(facility.timezone, now);
    // ENT-04, SPK-IAM-007: a pass issued to a person later merged opens the surviving person.
    const holderPersonId = pass.holder_person_id
      ? await this.directory.resolveCanonicalPersonId(organizationId, pass.holder_person_id)
      : null;
    const candidates = await this.candidates(db, organizationId, pass, holderPersonId);
    const personIds = candidates.map((c) => c.personId);
    const participations = await this.enrollments.participationsOf(organizationId, personIds, {
      from: window.start,
      to: window.end,
    });
    const offeringSessions = new Map<string, ResolvedActivity[]>();
    const sessionsOf = async (offeringId: string): Promise<ResolvedActivity[]> => {
      const cached = offeringSessions.get(offeringId);
      if (cached) return cached;
      const found = await this.resolver.sessionsInWindow(
        organizationId,
        offeringId,
        facility.id,
        window,
      );
      offeringSessions.set(offeringId, found);
      return found;
    };
    const live = personIds.length
      ? await db
          .selectFrom('session_checkins')
          .select(['id', 'person_id', 'activity_id', 'status', 'revision'])
          .where('organization_id', '=', organizationId)
          .where('person_id', 'in', personIds)
          .where('status', 'in', ['held', 'admitted'])
          .execute()
      : [];
    const open = personIds.length
      ? await db
          .selectFrom('visits')
          .select(['id', 'person_id'])
          .where('organization_id', '=', organizationId)
          .where('facility_id', '=', facility.id)
          .where('status', '=', 'on_site')
          .where('person_id', 'in', personIds)
          .execute()
      : [];

    const people: ScanPerson[] = [];
    for (const candidate of candidates) {
      const person = await this.people.detail(db, organizationId, candidate.personId);
      const participation = participations.find((p) => p.participantPersonId === person.id);
      const activities: ScanActivity[] = [];
      const seen = new Set<string>();
      const checkinOf = (activityId: string) => {
        const c = live.find((l) => l.person_id === person.id && l.activity_id === activityId);
        return c
          ? { id: c.id, status: c.status as 'held' | 'admitted', revision: c.revision }
          : null;
      };
      for (const booking of participation?.sessionBookings ?? []) {
        const sessions = await sessionsOf(booking.offeringId);
        const session = sessions.find((s) => s.detail.id === booking.sessionId);
        if (!session || seen.has(session.detail.id)) continue;
        seen.add(session.detail.id);
        activities.push({
          activity: session.detail,
          title: session.title,
          scheduledStart: session.start.toISOString(),
          scheduledEnd: session.end.toISOString(),
          basis: { kind: 'session_booking', id: booking.id, status: booking.status },
          checkin: checkinOf(session.detail.id),
        });
      }
      for (const enrollment of participation?.enrollments ?? []) {
        for (const session of await sessionsOf(enrollment.offeringId)) {
          if (seen.has(session.detail.id)) continue;
          seen.add(session.detail.id);
          activities.push({
            activity: session.detail,
            title: session.title,
            scheduledStart: session.start.toISOString(),
            scheduledEnd: session.end.toISOString(),
            basis: { kind: 'enrollment', id: enrollment.id, status: enrollment.status },
            checkin: checkinOf(session.detail.id),
          });
        }
      }
      activities.sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
      const visit = open.find((v) => v.person_id === person.id);
      const holderMayCollect =
        holderPersonId && candidate.relation === 'dependent' && person.kind === 'child'
          ? await this.authority.hasPermission(organizationId, holderPersonId, person.id, 'collect')
          : null;
      people.push({
        personId: person.id,
        givenName: person.givenName,
        familyName: person.familyName,
        kind: person.kind,
        relation: candidate.relation,
        onSite: visit !== undefined,
        visitId: visit?.id ?? null,
        holderMayCollect,
        activities,
      });
    }

    await this.uow.run(async ({ trx }) => {
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EntryActions.scanPass.id,
        targetType: 'pass',
        targetId: pass.id,
        correlationId,
        details: { facilityId: facility.id, people: people.length, recorded: 'nothing' },
      });
    });
    return {
      pass: { id: pass.id, holderKind: pass.holder_kind },
      facilityId: facility.id,
      scannedAt: now.toISOString(),
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      people,
      recorded: 'nothing',
      nextAction: 'select_arriving_people_and_sessions',
    };
  }

  /** The people a pass opens: the household members, or the holder and the people they may view. */
  private async candidates(
    db: Db | Trx,
    organizationId: string,
    pass: PassRow,
    holderPersonId: string | null,
  ) {
    const out: ScanCandidate[] = [];
    if (pass.holder_household_id) {
      const household = await this.households.detail(db, organizationId, pass.holder_household_id);
      for (const member of household.members) {
        const person = await this.directory.findPerson(organizationId, member.personId);
        if (person?.status === 'active') {
          out.push({ personId: member.personId, relation: 'household_member' });
        }
      }
      return out;
    }
    const holder = holderPersonId;
    if (!holder) return out;
    const person = await this.directory.findPerson(organizationId, holder);
    if (person?.status === 'active') out.push({ personId: holder, relation: 'holder' });
    // Authority, never household membership, decides whose sessions a personal pass opens (§4.5).
    for (const grant of await this.relationships.authoritiesOf(organizationId, holder)) {
      if (grant.subjectPersonId === holder || !grant.permissions.includes('view')) continue;
      const dependent = await this.directory.findPerson(organizationId, grant.subjectPersonId);
      if (dependent?.status === 'active') {
        out.push({ personId: grant.subjectPersonId, relation: 'dependent' });
      }
    }
    return out;
  }

  private async load(db: Db | Trx, organizationId: string, id: string) {
    return db
      .selectFrom('passes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }
}
