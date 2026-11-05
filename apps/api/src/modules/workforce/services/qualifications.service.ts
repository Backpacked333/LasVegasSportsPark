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
  type RequirementRow,
} from '../workforce.shared';
import { lockPerson } from './commitment-checker';
import { settleIfStillOpen } from './exception-settlement';
import { MergedPersons } from './merged-persons';
import { lockRequirementShared } from './requirement-locks';

/** An accepted assignment and what its requirement demands. */
interface UnderRequirement {
  id: string;
  person_id: string;
  facility_id: string;
  target_type: AssignmentTargetType;
  target_id: string;
  target_title: string;
  role: string;
  slot: number;
  scheduled_start: Date;
  required_qualifications: string[];
}

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
      // R2-RACES-02 (SPK-STAFF-001, SPK-READY-004): a revocation takes the party lock of everyone
      // whose assignability reads this evidence (the holder, and anyone a merge resolves to the same
      // person, WRK-05) before it writes; assertAssignable takes the same lock before it reads
      // qualifications. A concurrent acceptance therefore either reads the revocation and is
      // refused, or commits first and is found by flagUnqualifiedAssignments below, which also
      // takes the locks of the requirements those assignments name (a concurrent requirement edit
      // or creation is serialized there).
      if (next === 'revoked') {
        const holders = await this.merged.resolving(trx, organizationId, current.person_id);
        for (const personId of [...holders].sort()) {
          await lockPerson(trx, organizationId, personId);
        }
      }
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
   *
   * A person scope covers every assignment whose assignee resolves to the same person as the
   * evidence's holder (WRK-05): evidence recorded for a merged person counts for the survivor's
   * assignments (see `check`), so revoking it can leave those unqualified too.
   *
   * R2-RACES-02: the person scope (a revocation, under the holders' party locks) takes the shared
   * key lock and the share lock of every requirement those assignments name, in (target, role)
   * order, and reads what each requires after the lock. A requirement edit (row `FOR UPDATE`) or
   * creation (key exclusive) committing meanwhile is therefore waited for and read, and one that
   * starts later waits for the revocation and then reads it. The target scope is called by those
   * requirement commands, under their own lock.
   */
  async flagUnqualifiedAssignments(
    trx: Trx,
    organizationId: string,
    scope:
      | { personId: string; kind: string }
      | { targetType: AssignmentTargetType; targetId: string; role: string },
  ): Promise<string[]> {
    const rows =
      'personId' in scope
        ? await this.acceptedRequiringKind(trx, organizationId, scope.personId, scope.kind)
        : await this.acceptedUnderRequirement(trx, organizationId, scope);
    const raised: string[] = [];
    for (const row of rows) {
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

  /**
   * R4-OPS-MODULES-08 rework (SPK-UX-006 the queue reflects reality, SPK-STAFF-001,
   * SPK-READY-004): after an edit of the requirement (`requirement` is the row as the edit wrote
   * it), the open or acknowledged `workforce.unqualified_assignment` exception of an accepted
   * assignment of its target and role is resolved once the requirement no longer makes that
   * assignment unqualified, the facts under which {@link flagUnqualifiedAssignments} would not
   * raise it and readiness stops reporting it:
   *  - `slot_not_required`: its slot is above the required count;
   *  - `qualified`: its assignee holds every qualification the requirement now names, verified and
   *    valid at the start (none named included).
   * An assignee still lacking one keeps the card. The resolution names the requirement's id,
   * revision, count and qualifications, the assignment, its slot and the ground (system actor
   * `workforce.coverage`); the exception stays as history. The caller holds the requirement row
   * `FOR UPDATE`, which a revocation's flagging and an acceptance of the role wait for (they take
   * its share lock), so neither raises beside this edit on facts it no longer reads; a card an
   * operator settles meanwhile is skipped ({@link settleIfStillOpen}). Idempotent: only open or
   * acknowledged exceptions match. Returns the resolved exception ids.
   */
  async resolveUnqualifiedNoLongerLacking(
    trx: Trx,
    requirement: RequirementRow,
    editReason: string | null,
    correlationId: string | null,
  ): Promise<string[]> {
    const organizationId = requirement.organization_id;
    const accepted = await trx
      .selectFrom('assignments')
      .select(['id', 'person_id', 'slot', 'scheduled_start'])
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', requirement.target_type)
      .where('target_id', '=', requirement.target_id)
      .where('role', '=', requirement.role)
      .where('status', '=', 'accepted')
      .orderBy('id')
      .execute();
    if (accepted.length === 0) return [];
    const byKey = new Map(accepted.map((a) => [`${UNQUALIFIED_ASSIGNMENT}:${a.id}`, a]));
    const open = await trx
      .selectFrom('operational_exceptions')
      .select(['id', 'dedupe_key'])
      .where('organization_id', '=', organizationId)
      .where('category', '=', UNQUALIFIED_ASSIGNMENT)
      .where('dedupe_key', 'in', [...byKey.keys()])
      .where('status', 'in', ['open', 'acknowledged'])
      .orderBy('id')
      .execute();
    const role = requirement.role.replaceAll('_', ' ');
    const names = requirement.required_qualifications;
    const edit = `(revision ${requirement.revision}).${editReason ? ` ${editReason}` : ''}`;
    const resolved: string[] = [];
    for (const exception of open) {
      const assignment = exception.dedupe_key ? byKey.get(exception.dedupe_key) : undefined;
      if (!assignment) continue;
      let ground: 'slot_not_required' | 'qualified';
      let reason: string;
      if (assignment.slot > requirement.required_count) {
        ground = 'slot_not_required';
        const count = requirement.required_count;
        reason = `Slot ${assignment.slot} is no longer required: the ${role} requirement now requires ${count} slot${count === 1 ? '' : 's'} ${edit}`;
      } else {
        const checks = await this.check(
          trx,
          organizationId,
          assignment.person_id,
          names,
          new Date(assignment.scheduled_start),
        );
        if (checks.some((c) => c.status !== 'held')) continue;
        ground = 'qualified';
        reason =
          names.length === 0
            ? `The ${role} requirement no longer names a qualification ${edit}`
            : `The assignee holds every qualification the ${role} requirement now names (${names.join(', ')}) ${edit}`;
      }
      const settled = await settleIfStillOpen(
        this.exceptions,
        trx,
        organizationId,
        exception.id,
        'resolved',
        {
          reason,
          resolution: {
            requirementId: requirement.id,
            requirementRevision: requirement.revision,
            requiredCount: requirement.required_count,
            requiredQualifications: names,
            assignmentId: assignment.id,
            slot: assignment.slot,
            ground,
          },
          correlationId,
        },
      );
      if (settled) resolved.push(exception.id);
    }
    return resolved;
  }

  private acceptedAssignments(trx: Trx, organizationId: string) {
    return trx
      .selectFrom('assignments as a')
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
      ])
      .where('a.organization_id', '=', organizationId)
      .where('a.status', '=', 'accepted')
      .where('a.scheduled_end', '>', this.clock.now());
  }

  /** Accepted assignments of a target's role whose requirement is in force and counts their slot. */
  private async acceptedUnderRequirement(
    trx: Trx,
    organizationId: string,
    scope: { targetType: AssignmentTargetType; targetId: string; role: string },
  ): Promise<UnderRequirement[]> {
    return (
      this.acceptedAssignments(trx, organizationId)
        .innerJoin('assignment_requirements as r', (join) =>
          join
            .onRef('r.organization_id', '=', 'a.organization_id')
            .onRef('r.target_type', '=', 'a.target_type')
            .onRef('r.target_id', '=', 'a.target_id')
            .onRef('r.role', '=', 'a.role'),
        )
        .select('r.required_qualifications')
        // WRK-02: a retired requirement demands nothing.
        .where('r.retired_at', 'is', null)
        .whereRef('a.slot', '<=', 'r.required_count')
        .where('a.target_type', '=', scope.targetType)
        .where('a.target_id', '=', scope.targetId)
        .where('a.role', '=', scope.role)
        .orderBy('a.id')
        .execute()
    );
  }

  /**
   * Accepted assignments of everyone resolving to the person whose requirement (in force, counting
   * their slot) names the kind, read under each requirement's key and share lock (R2-RACES-02).
   */
  private async acceptedRequiringKind(
    trx: Trx,
    organizationId: string,
    personId: string,
    kind: string,
  ): Promise<UnderRequirement[]> {
    const assignments = await this.acceptedAssignments(trx, organizationId)
      .where('a.person_id', 'in', await this.merged.resolving(trx, organizationId, personId))
      .orderBy('a.id')
      .execute();
    const keyOf = (a: { target_type: string; target_id: string; role: string }) =>
      `${a.target_type}\u0000${a.target_id}\u0000${a.role}`;
    const requirements = new Map<string, RequirementRow | undefined>();
    const byKey = [...new Map(assignments.map((a) => [keyOf(a), a])).entries()].sort(([x], [y]) =>
      x < y ? -1 : x > y ? 1 : 0,
    );
    for (const [key, a] of byKey) {
      requirements.set(
        key,
        await lockRequirementShared(trx, organizationId, a.target_type, a.target_id, a.role),
      );
    }
    const out: UnderRequirement[] = [];
    for (const a of assignments) {
      const requirement = requirements.get(keyOf(a));
      if (!requirement || requirement.retired_at !== null) continue;
      if (a.slot > requirement.required_count) continue;
      if (!requirement.required_qualifications.includes(kind)) continue;
      out.push({ ...a, required_qualifications: requirement.required_qualifications });
    }
    return out;
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
