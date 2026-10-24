import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  hasStaffRole,
  newId,
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
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import { QualificationMachine, type QualificationEvent } from '../workforce.state-machines';
import {
  organizationOf,
  qualificationHoldsAt,
  toQualification,
  type QualificationRow,
} from '../workforce.shared';

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
    if (personId) q = q.where('person_id', '=', personId);
    if (query.kind) q = q.where('kind', '=', query.kind);
    if (query.status) q = q.where('status', '=', query.status);
    return (await q.execute()).map(toQualification);
  }

  /**
   * Explains, per required kind, whether the person holds a verified qualification valid at the
   * instant (SPK-STAFF-001). Used by assignments and the replacement workflow.
   */
  async check(
    db: Db | Trx,
    organizationId: string,
    personId: string,
    kinds: readonly string[],
    at: Date,
  ): Promise<QualificationCheck[]> {
    if (kinds.length === 0) return [];
    const rows = await db
      .selectFrom('qualifications')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('kind', 'in', [...kinds])
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

  /** People holding every kind, verified and valid at the instant (replacement pool). */
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
    for (const row of rows) {
      if (!qualificationHoldsAt(row, at)) continue;
      const set = byPerson.get(row.person_id) ?? new Set<string>();
      set.add(row.kind);
      byPerson.set(row.person_id, set);
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
      return toQualification(row);
    });
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
