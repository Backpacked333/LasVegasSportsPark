import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type Approval,
  type ApprovePolicyVersionInput,
  type CreatePolicyVersionInput,
  type ListPolicyVersionsQuery,
  type Page,
  type PolicyKind,
  type PolicyVersion,
  type Principal,
  type RetirePolicyVersionInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
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
import { CatalogActions } from '../catalog.actions';
import { CatalogEvents } from '../catalog.events';
import { POLICY_APPROVAL_ACTION } from '../catalog.policy';
import type { PolicyPort } from '../catalog.ports';
import { organizationOf, toApproval, toPolicyVersion } from '../catalog.shared';
import { PolicyVersionMachine } from '../catalog.state-machines';

const Cursor = z.object({ kind: z.string(), key: z.string(), version: z.number(), id: z.string() });

/**
 * Versioned policies (§4.4 PolicyVersion/Approval, SPK-REG-002, SPK-PAY-003). A version is drafted
 * by any policy author, approved by the role that owns its kind (catalog.policy.ts), and retired
 * explicitly: approving a newer version retires nothing automatically, so two approved versions
 * may coexist with different effective windows. Approved content is immutable (migration 0200).
 */
@Injectable()
export class PoliciesService implements PolicyPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async createPolicyVersion(
    principal: Principal,
    body: CreatePolicyVersionInput,
    correlationId: string | null,
  ): Promise<PolicyVersion> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.createPolicyVersion, {
      type: 'policy_version',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const latest = await trx
        .selectFrom('policy_versions')
        .select((eb) => eb.fn.max('version').as('version'))
        .where('organization_id', '=', organizationId)
        .where('kind', '=', body.kind)
        .where('key', '=', body.key)
        .executeTakeFirst();
      const version = (latest?.version ?? 0) + 1;
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('policy_versions')
          .values({
            id,
            organization_id: organizationId,
            kind: body.kind,
            key: body.key,
            version,
            title: body.title,
            content: json(body.content),
            effective_from: new Date(body.effectiveFrom),
            effective_to: body.effectiveTo ? new Date(body.effectiveTo) : null,
            approved_by: null,
            approved_at: null,
            retired_at: null,
            retired_reason: null,
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('Another version of this policy was created concurrently.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.policy_version_created',
        targetType: 'policy_version',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { kind: body.kind, key: body.key, version },
      });
      await this.outbox.enqueue(trx, CatalogEvents.policyVersionCreated, {
        organizationId,
        aggregateType: 'policy_version',
        aggregateId: id,
        payload: { policyVersionId: id, kind: body.kind, key: body.key, version },
        correlationId,
      });
      return toPolicyVersion(row);
    });
  }

  /** Approval by the role that owns the kind; records an approval fact (§4.4 Approval). */
  async approve(
    principal: Principal,
    id: string,
    body: ApprovePolicyVersionInput,
    correlationId: string | null,
  ): Promise<PolicyVersion> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadForUpdate(trx, organizationId, id);
      await this.authorization.require(principal, POLICY_APPROVAL_ACTION[current.kind], {
        type: 'policy_version',
        id,
        organizationId,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = PolicyVersionMachine.next(current.approval_status, 'approve');
      const now = this.clock.now();
      const updated = await trx
        .updateTable('policy_versions')
        .set({
          approval_status: next,
          approved_by: json(snapshotActor(principal)),
          approved_at: now,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      const approvalId = await this.recordApproval(trx, principal, organizationId, {
        subjectType: 'policy_version',
        subjectId: id,
        reason: body.reason ?? null,
        details: { kind: current.kind, key: current.key, version: current.version },
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.policy_version_approved',
        targetType: 'policy_version',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId,
        details: { approvalId },
      });
      await this.outbox.enqueue(trx, CatalogEvents.policyVersionApproved, {
        organizationId,
        aggregateType: 'policy_version',
        aggregateId: id,
        payload: {
          policyVersionId: id,
          approvalId,
          kind: current.kind,
          key: current.key,
          version: current.version,
          effectiveFrom: new Date(updated.effective_from).toISOString(),
          effectiveTo: updated.effective_to ? new Date(updated.effective_to).toISOString() : null,
        },
        correlationId,
      });
      return toPolicyVersion(updated);
    });
  }

  async retire(
    principal: Principal,
    id: string,
    body: RetirePolicyVersionInput,
    correlationId: string | null,
  ): Promise<PolicyVersion> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadForUpdate(trx, organizationId, id);
      await this.authorization.require(principal, POLICY_APPROVAL_ACTION[current.kind], {
        type: 'policy_version',
        id,
        organizationId,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = PolicyVersionMachine.next(current.approval_status, 'retire');
      const now = this.clock.now();
      let effectiveTo: Date | undefined;
      if (body.effectiveTo) {
        effectiveTo = new Date(body.effectiveTo);
        if (effectiveTo.getTime() <= new Date(current.effective_from).getTime()) {
          throw errors.validation('effectiveTo must be after effectiveFrom.', {
            path: 'effectiveTo',
          });
        }
        // SPK-PAY-002, §4.4: retirement only shortens the approved window from now on. A past
        // effectiveTo would exclude instants at which records already cited this version; a later
        // one would extend what was approved.
        if (effectiveTo.getTime() < now.getTime()) {
          throw errors.validation('effectiveTo must not be in the past.', { path: 'effectiveTo' });
        }
        if (
          current.effective_to !== null &&
          effectiveTo.getTime() > new Date(current.effective_to).getTime()
        ) {
          throw errors.validation(
            'effectiveTo must not extend the approved effective window; approve a new version instead.',
            { path: 'effectiveTo' },
          );
        }
      }
      const updated = await trx
        .updateTable('policy_versions')
        .set({
          approval_status: next,
          retired_at: now,
          retired_reason: body.reason,
          effective_to: effectiveTo,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.policy_version_retired',
        targetType: 'policy_version',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, CatalogEvents.policyVersionRetired, {
        organizationId,
        aggregateType: 'policy_version',
        aggregateId: id,
        payload: {
          policyVersionId: id,
          kind: current.kind,
          key: current.key,
          version: current.version,
          reason: body.reason,
        },
        correlationId,
      });
      return toPolicyVersion(updated);
    });
  }

  /**
   * Approved versions are readable by every authenticated principal of the organization (a
   * customer must read the wording they acknowledge); drafts are staff-only.
   */
  async get(principal: Principal, id: string): Promise<PolicyVersion> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('policy_versions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('policy version', id);
    if (row.approval_status === 'draft') {
      await this.authorization.require(principal, CatalogActions.readCatalog, {
        type: 'policy_version',
        id,
        organizationId,
      });
    }
    return toPolicyVersion(row);
  }

  async list(principal: Principal, query: ListPolicyVersionsQuery): Promise<Page<PolicyVersion>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'policy_version',
      organizationId,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('policy_versions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('kind')
      .orderBy('key')
      .orderBy('version')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.kind) q = q.where('kind', '=', query.kind);
    if (query.key) q = q.where('key', '=', query.key);
    if (query.approvalStatus) q = q.where('approval_status', '=', query.approvalStatus);
    if (cursor) {
      q = q.where(
        sql<boolean>`(kind, key, version, id) > (${cursor.kind}, ${cursor.key}, ${cursor.version}, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const items = rows.slice(0, query.limit).map(toPolicyVersion);
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? encodeCursor({ kind: last.kind, key: last.key, version: last.version, id: last.id })
        : null,
    };
  }

  async listApprovals(principal: Principal, id: string): Promise<Approval[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'policy_version',
      id,
      organizationId,
    });
    const rows = await this.db
      .selectFrom('approvals')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_type', '=', 'policy_version')
      .where('subject_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    return rows.map(toApproval);
  }

  // -------------------------------------------------------------------------------------------
  // PolicyPort
  // -------------------------------------------------------------------------------------------

  async getPolicyVersion(
    organizationId: string,
    policyVersionId: string,
    trx?: Trx,
  ): Promise<PolicyVersion | null> {
    const row = await (trx ?? this.db)
      .selectFrom('policy_versions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', policyVersionId)
      .executeTakeFirst();
    return row ? toPolicyVersion(row) : null;
  }

  async currentPolicyVersion(
    organizationId: string,
    kind: PolicyKind,
    key: string,
    at: Date,
    trx?: Trx,
  ): Promise<PolicyVersion | null> {
    const row = await (trx ?? this.db)
      .selectFrom('policy_versions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('kind', '=', kind)
      .where('key', '=', key)
      .where('approval_status', '=', 'approved')
      .where('effective_from', '<=', at)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .orderBy('version', 'desc')
      .executeTakeFirst();
    return row ? toPolicyVersion(row) : null;
  }

  async hasAcknowledgment(
    organizationId: string,
    subjectPersonId: string,
    policyVersionId: string,
    trx?: Trx,
  ): Promise<boolean> {
    const row = await (trx ?? this.db)
      .selectFrom('acknowledgments')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', '=', subjectPersonId)
      .where('policy_version_id', '=', policyVersionId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row !== undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Shared with offerings: approval facts for any subject.
  // -------------------------------------------------------------------------------------------

  async recordApproval(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    input: {
      subjectType: 'policy_version' | 'offering_publication';
      subjectId: string;
      reason: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<string> {
    const id = newId();
    await trx
      .insertInto('approvals')
      .values({
        id,
        organization_id: organizationId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        decision: 'approved',
        actor: json(snapshotActor(principal)),
        actor_person_id: principal.personId,
        reason: input.reason,
        details: json(input.details ?? {}),
        occurred_at: this.clock.now(),
      })
      .execute();
    return id;
  }

  private async loadForUpdate(trx: Trx, organizationId: string, id: string) {
    const row = await trx
      .selectFrom('policy_versions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.notFound('policy version', id);
    return row;
  }
}
