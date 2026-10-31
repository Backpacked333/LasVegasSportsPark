import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  hasStaffRole,
  newId,
  type AssignmentTargetType,
  type CreateQualificationBody,
  type ListQualificationsQuery,
  type Principal,
  type Qualification,
  type QualificationDecisionBody,
  type QualificationReasonBody,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import { UNQUALIFIED_ASSIGNMENT } from '../workforce.policy';
import { QualificationMachine, type QualificationEvent } from '../workforce.state-machines';
import {
  organizationOf,
  qualificationHoldsAt,
  toQualification,
  type QualificationRow,
} from '../workforce.shared';
import { MergedPersons } from './merged-persons';

export interface QualificationCheck {
  kind: string;
  status: 'held' | 'missing' | 'unverified' | 'expired';
  qualificationIds: string[];
}

/**
 * Qualification evidence (SPK-STAFF-001 "qualification evidence where required"). Evidence is a
 * reference (document key, licence number), never an upload. A person may submit their own
 * evidence for verification; staff holding qualification management record, verify, reject and
 * revoke it, and nobody verifies their own. Only a verified qualification inside its validity
 * window satisfies a requirement; revoked and expired ones stay for history.
 */
@Injectable()
export class QualificationsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly exceptions: OperationalExceptions,
    private readonly merged: MergedPersons,
  ) {}

  async create(
    principal: Principal,
    body: CreateQualificationBody,
    correlationId: string | null,
  ): Promise<Qualification> {
    const organizationId = organizationOf(principal);
    const personId = body.personId ?? principal.personId;
    if (!personId) throw errors.validation('personId is required.');
    const self = personId === principal.personId;
    if (body.verify && self) {
      throw errors.accessDenied('Qualification evidence cannot be verified by its holder.');
    }
    const action =
      self && !body.verify
        ? WorkforceActions.submitQualification
        : WorkforceActions.manageQualification;
    await this.authorization.require(principal, action, {
      type: 'qualification',
      organizationId,
      subjectPersonIds: [personId],
    });
    return this.uow.run(async ({ trx }) => {
      const person = await this.people.findPerson(organizationId, personId, trx);
      if (!person || person.status !== 'active') throw errors.notFound('person', personId);
      const id = newId();
      const now = this.clock.now();
      const actor = json(snapshotActor(principal));
      await trx
        .insertInto('qualifications')
        .values({
          id,
          organization_id: organizationId,
          person_id: personId,
          kind: body.kind,
          level: body.level ?? null,
          evidence_reference: body.evidenceReference ?? null,
          valid_from: new Date(body.validFrom),
          valid_to: body.validTo ? new Date(body.validTo) : null,
          status: body.verify ? 'verified' : 'pending_verification',
          verified_by: body.verify ? actor : null,
          verified_by_person_id: body.verify ? principal.personId : null,
          verified_at: body.verify ? now : null,
          status_reason: null,
          status_changed_at: body.verify ? now : null,
          recorded_by: actor,
          recorded_by_person_id: principal.personId,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: action.id,
        targetType: 'qualification',
        targetId: id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: { personId, kind: body.kind, verified: body.verify },
      });
      const row = (await this.load(trx, organizationId, id)) as QualificationRow;
      await this.notify(trx, row, correlationId);
      return toQualification(row);
    });
  }

  verify(
    principal: Principal,
    id: string,
    body: QualificationDecisionBody,
    correlationId: string | null,
  ): Promise<Qualification> {
    return this.decide(principal, id, 'verify', body.expectedRevision, body.reason, correlationId);
  }

  reject(
    principal: Principal,
    id: string,
    body: QualificationReasonBody,
    correlationId: string | null,
  ): Promise<Qualification> {
    return this.decide(principal, id, 'reject', body.expectedRevision, body.reason, correlationId);
  }

  revoke(
    principal: Principal,
    id: string,
    body: QualificationReasonBody,
    correlationId: string | null,
  ): Promise<Qualification> {
    return this.decide(principal, id, 'revoke', body.expectedRevision, body.reason, correlationId);
  }

  async list(principal: Principal, query: ListQualificationsQuery): Promise<Qualification[]> {
    const organizationId = organizationOf(principal);
    // Staff readers list the organization; everyone else defaults to their own evidence.
    const reader = hasStaffRole(principal, ...WorkforceActions.readQualifications.staffRoles);
    const personId = query.personId ?? (reader ? null : principal.personId);
    await this.authorization.require(principal, WorkforceActions.readQualifications, {
      type: 'qualification',
      organizationId,
      subjectPersonIds: personId ? [personId] : [],
      protected: personId !== null,
    });
    let q = this.db
      .selectFrom('qualifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('person_id')
      .orderBy('kind')
      .orderBy('valid_from', 'desc');
    // WRK-05, SPK-IAM-007: a survivor's evidence includes what was recorded for people merged into it.
    if (personId) {
      q = q.where(
        'person_id',
        'in',
        await this.merged.resolving(this.db, organizationId, personId),
      );
    }
    if (query.kind) q = q.where('kind', '=', query.kind);
    if (query.status) q = q.where('status', '=', query.status);
    return (await q.execute()).map(toQualification);
  }

  /**
   * Explains, per required kind, whether the person holds a verified qualification valid at the
   * instant (SPK-STAFF-001). Used by assignments and the replacement workflow.
   *
   * WRK-05, SPK-IAM-007: evidence recorded for anyone identity resolves to the same person (the
   * survivor of a merge and the people merged into it) counts; no row is rewritten.
   */
  async check(
    db: Db | Trx,
    organizationId: string,
    personId: string,
    kinds: readonly string[],
    at: Date,
  ): Promise<QualificationCheck[]> {
    if (kinds.length === 0) return [];
    const personIds = await this.merged.resolving(db, organizationId, personId);
    const rows = await db
      .selectFrom('qualifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', 'in', personIds)
      .where('kind', 'in', [...kinds])
      .orderBy('id')
      .execute();
    return kinds.map((kind) => {
      const own = rows.filter((r) => r.kind === kind);
      const held = own.filter((r) => qualificationHoldsAt(r, at));
      if (held.length > 0) {
        return { kind, status: 'held', qualificationIds: held.map((r) => r.id) };
      }
      const verified = own.filter((r) => r.status === 'verified');
      if (verified.length > 0) {
        return { kind, status: 'expired', qualificationIds: verified.map((r) => r.id) };
      }
      const pending = own.filter((r) => r.status === 'pending_verification');
      if (pending.length > 0) {
        return { kind, status: 'unverified', qualificationIds: pending.map((r) => r.id) };
      }
      return { kind, status: 'missing', qualificationIds: [] };
    });
  }

  /**
   * People holding every kind, verified and valid at the instant (replacement pool). WRK-05: a
   * merged person's evidence counts for the survivor, so holders are the canonical persons.
   */
  async holdersOfAll(
    db: Db | Trx,
    organizationId: string,
    kinds: readonly string[],
    at: Date,
  ): Promise<string[]> {
    if (kinds.length === 0) return [];
    const rows = await db
      .selectFrom('qualifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('kind', 'in', [...kinds])
      .where('status', '=', 'verified')
      .execute();
    const byPerson = new Map<string, Set<string>>();
    const canonical = new Map<string, string>();
    for (const row of rows) {
      if (!qualificationHoldsAt(row, at)) continue;
      let holder = canonical.get(row.person_id);
      if (holder === undefined) {
        holder = await this.merged.canonical(db, organizationId, row.person_id);
        canonical.set(row.person_id, holder);
      }
      const set = byPerson.get(holder) ?? new Set<string>();
      set.add(row.kind);
      byPerson.set(holder, set);
    }
    return [...byPerson.entries()]
      .filter(([, held]) => kinds.every((k) => held.has(k)))
      .map(([personId]) => personId)
      .sort();
  }

  private async decide(
    principal: Principal,
    id: string,
    event: QualificationEvent,
    expectedRevision: number | undefined,
    reason: string | undefined,
    correlationId: string | null,
  ): Promise<Qualification> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      if (!current) throw errors.protectedNotFound('qualification');
      await this.authorization.require(principal, WorkforceActions.readQualifications, {
        type: 'qualification',
        id,
        organizationId,
        subjectPersonIds: [current.person_id],
        protected: true,
      });
      await this.authorization.require(principal, WorkforceActions.manageQualification, {
        type: 'qualification',
        id,
        organizationId,
      });
      if (event === 'verify' && current.person_id === principal.personId) {
        throw errors.accessDenied('Qualification evidence cannot be verified by its holder.');
      }
      assertExpectedRevision(expectedRevision, current.revision);
      const next = QualificationMachine.next(current.status, event);
      const now = this.clock.now();
      await trx
        .updateTable('qualifications')
        .set({
          status: next,
          verified_by: event === 'verify' ? json(snapshotActor(principal)) : undefined,
          verified_by_person_id: event === 'verify' ? principal.personId : undefined,
          verified_at: event === 'verify' ? now : undefined,
          status_reason: event === 'verify' ? null : (reason ?? null),
          status_changed_at: now,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: `workforce.qualification_${next}`,
        targetType: 'qualification',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: reason ?? null,
        correlationId,
      });
      const row = (await this.load(trx, organizationId, id)) as QualificationRow;
      await this.notify(trx, row, correlationId);
      if (next === 'revoked') {
        await this.flagUnqualifiedAssignments(trx, organizationId, {
          personId: row.person_id,
          kind: row.kind,
        });
      }
      return toQualification(row);
    });
  }

  /**
   * SPK-STAFF-001, SPK-READY-004: accepted, not yet finished assignments whose requirement names a
   * qualification the assignee no longer holds (verified and valid at the start) raise
   * `workforce.unqualified_assignment` for the assigners' queue, once per assignment. Nothing is
   * withdrawn automatically: whether the person may still work is an operator decision (POL-033
   * pending). Readiness reports the same lapse at read time.
   */
  async flagUnqualifiedAssignments(
    trx: Trx,
    organizationId: string,
    scope:
      | { personId: string; kind: string }
      | { targetType: AssignmentTargetType; targetId: string; role: string },
  ): Promise<string[]> {
    let q = trx
      .selectFrom('assignments as a')
      .innerJoin('assignment_requirements as r', (join) =>
        join
          .onRef('r.organization_id', '=', 'a.organization_id')
          .onRef('r.target_type', '=', 'a.target_type')
          .onRef('r.target_id', '=', 'a.target_id')
          .onRef('r.role', '=', 'a.role'),
      )
      .select([
        'a.id',
        'a.person_id',
        'a.facility_id',
        'a.target_type',
        'a.target_id',
        'a.target_title',
        'a.role',
        'a.slot',
        'a.scheduled_start',
        'r.required_qualifications',
      ])
      .where('a.organization_id', '=', organizationId)
      // WRK-02: a retired requirement demands nothing.
      .where('r.retired_at', 'is', null)
      .where('a.status', '=', 'accepted')
      .where('a.scheduled_end', '>', this.clock.now())
      .whereRef('a.slot', '<=', 'r.required_count')
      .orderBy('a.id');
    if ('personId' in scope) {
      q = q
        .where('a.person_id', '=', scope.personId)
        .where(sql<boolean>`${scope.kind} = any(r.required_qualifications)`);
    } else {
      q = q
        .where('a.target_type', '=', scope.targetType)
        .where('a.target_id', '=', scope.targetId)
        .where('a.role', '=', scope.role);
    }
    const raised: string[] = [];
    for (const row of await q.execute()) {
      if (row.required_qualifications.length === 0) continue;
      const checks = await this.check(
        trx,
        organizationId,
        row.person_id,
        row.required_qualifications,
        new Date(row.scheduled_start),
      );
      const lapsed = checks.filter((c) => c.status !== 'held');
      if (lapsed.length === 0) continue;
      const exception = await this.exceptions.raise(trx, {
        organizationId,
        facilityId: row.facility_id,
        category: UNQUALIFIED_ASSIGNMENT,
        severity: 'high',
        title: `Accepted ${row.role.replaceAll('_', ' ')} (slot ${row.slot}) lacks a required qualification for ${row.target_title}`,
        affectedType: 'assignment',
        affectedId: row.id,
        ownerQueue: row.target_type === 'fixture' ? 'league_manager' : 'scheduler',
        deadlineAt: new Date(row.scheduled_start),
        dedupeKey: `${UNQUALIFIED_ASSIGNMENT}:${row.id}`,
        details: {
          assignmentId: row.id,
          targetType: row.target_type,
          targetId: row.target_id,
          role: row.role,
          slot: row.slot,
          qualifications: lapsed.map((c) => ({ kind: c.kind, status: c.status })),
          replacementsHref: `/v1/assignments/${row.id}/replacements`,
        },
      });
      raised.push(exception.id);
    }
    return raised;
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<QualificationRow | undefined> {
    let q = db
      .selectFrom('qualifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async notify(trx: Trx, row: QualificationRow, correlationId: string | null) {
    await this.outbox.enqueue(trx, WorkforceEvents.qualificationChanged, {
      organizationId: row.organization_id,
      aggregateType: 'qualification',
      aggregateId: row.id,
      correlationId,
      payload: {
        qualificationId: row.id,
        personId: row.person_id,
        kind: row.kind,
        status: row.status,
      },
    });
  }
}
