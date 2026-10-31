import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  IMPORT_ENTITY_TYPES,
  newId,
  type AuthorityAssignment,
  type AuthorityMatrix,
  type AuthorityMatrixQuery,
  type AuthorityResolution,
  type CreateAuthorityAssignmentInput,
  type EndAuthorityAssignmentInput,
  type ImportEntityTypeValue,
  type ListAuthorityAssignmentsQuery,
  type Page,
  type Principal,
  type RecordAuthorityScope,
} from '@sportspark/contracts';
import {
  isExclusionViolation,
  isForeignKeyViolation,
  json,
  type AuthorityScopeKind,
  type Db,
} from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  currentTransaction,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type RecordAuthorityPort,
  type Trx,
} from '../../../kernel';
import { MigrationActions } from '../migration.actions';
import { MigrationEvents } from '../migration.events';
import type { AuthorityGuardPort, AuthorityScopeRef } from '../migration.ports';
import {
  afterKeyset,
  createdAtText,
  iso,
  keysetPage,
  organizationOf,
  readKeysetCursor,
  scopeOf,
  toAuthorityAssignment,
  type AssignmentRow,
  type Reader,
} from '../migration.shared';

const SPECIFICITY: Record<AuthorityScopeKind, number> = {
  organization: 1,
  facility: 2,
  program: 3,
  competition: 3,
};

/**
 * The authority matrix (§5.6) and the AuthorityGuard port (§4.7 invariant 11). One record
 * category and scope has exactly one authoritative system at any instant — the database
 * exclusion constraint `authority_assignments_one_authority` is the guarantee; this service gives
 * the earlier, explained refusal. A transfer ends the assignment in effect and starts the next one
 * at the same instant in one transaction, and must name the assignment it supersedes with its
 * revision (§4.9: a stale transfer fails rather than overwriting newer work). Authority is never
 * assigned or ended retroactively: the record of who was authoritative is history (§4.7.9).
 *
 * Resolution picks the most specific scope in effect (program/competition, then facility, then
 * organization). Two different answers at the same specificity are treated as a conflict and
 * reported as `legacy` so writes are refused rather than duplicated. Without any assignment
 * SportsPark is authoritative.
 */
@Injectable()
export class AuthorityService implements AuthorityGuardPort, RecordAuthorityPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  // -------------------------------------------------------------------------------------------
  // AuthorityGuardPort
  // -------------------------------------------------------------------------------------------

  async resolve(
    organizationId: string,
    category: ImportEntityTypeValue,
    scope: AuthorityScopeRef = {},
    at: Date = this.clock.now(),
    trx?: Trx,
  ): Promise<AuthorityResolution> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const rows = await db
      .selectFrom('authority_assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('record_category', '=', category)
      .where('effective_from', '<=', at)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .where((eb) => {
        const scopes = [eb('scope_kind', '=', 'organization')];
        if (scope.facilityId) {
          scopes.push(
            eb.and([eb('scope_kind', '=', 'facility'), eb('facility_id', '=', scope.facilityId)]),
          );
        }
        if (scope.programId) {
          scopes.push(
            eb.and([eb('scope_kind', '=', 'program'), eb('program_id', '=', scope.programId)]),
          );
        }
        if (scope.competitionId) {
          scopes.push(
            eb.and([
              eb('scope_kind', '=', 'competition'),
              eb('competition_id', '=', scope.competitionId),
            ]),
          );
        }
        return eb.or(scopes);
      })
      .execute();
    if (rows.length === 0) {
      return {
        recordCategory: category,
        authoritativeSystem: 'sportspark',
        basis: 'default',
        assignmentId: null,
        scope: null,
        effectiveFrom: null,
        effectiveTo: null,
      };
    }
    const top = Math.max(...rows.map((r) => SPECIFICITY[r.scope_kind]));
    const winners = rows.filter((r) => SPECIFICITY[r.scope_kind] === top);
    const systems = new Set(winners.map((r) => r.authoritative_system));
    const chosen = winners[0] as AssignmentRow;
    if (systems.size > 1) {
      return {
        recordCategory: category,
        authoritativeSystem: 'legacy',
        basis: 'conflict',
        assignmentId: null,
        scope: null,
        effectiveFrom: null,
        effectiveTo: null,
      };
    }
    return {
      recordCategory: category,
      authoritativeSystem: chosen.authoritative_system,
      basis: 'assignment',
      assignmentId: chosen.id,
      scope: scopeOf(chosen),
      effectiveFrom: iso(chosen.effective_from),
      effectiveTo: chosen.effective_to ? iso(chosen.effective_to) : null,
    };
  }

  async assertSportsparkAuthority(
    organizationId: string,
    category: ImportEntityTypeValue,
    scope: AuthorityScopeRef = {},
    trx?: Trx,
  ): Promise<AuthorityResolution> {
    const resolution = await this.resolve(organizationId, category, scope, this.clock.now(), trx);
    if (resolution.authoritativeSystem === 'sportspark') return resolution;
    throw new DomainError(
      'ACCESS_DENIED',
      resolution.basis === 'conflict'
        ? `Authority for ${category} records is ambiguous for this scope; writes are refused until the authority matrix is corrected.`
        : `The legacy system is still authoritative for ${category} records; a synchronized copy does not become an independent writer (§5.6).`,
      {
        nextAction: 'write_in_authoritative_system',
        details: {
          code: 'LEGACY_AUTHORITY',
          recordCategory: category,
          basis: resolution.basis,
          assignmentId: resolution.assignmentId,
        },
      },
    );
  }

  /**
   * For a write whose scope cannot be proven before the owning module loads the record: refuses
   * while ANY assignment of the category in effect now, at any scope, names the legacy system
   * (§4.7 invariant 11 — ambiguity refuses rather than duplicates; §4.8 the scope is never taken
   * from client-supplied identifiers). Without such an assignment SportsPark is authoritative.
   */
  async assertNoLegacyAuthorityInEffect(
    organizationId: string,
    category: ImportEntityTypeValue,
    trx?: Trx,
  ): Promise<void> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const at = this.clock.now();
    const legacy = await db
      .selectFrom('authority_assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('record_category', '=', category)
      .where('authoritative_system', '=', 'legacy')
      .where('effective_from', '<=', at)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
      .orderBy('effective_from')
      .orderBy('id')
      .executeTakeFirst();
    if (!legacy) return;
    throw new DomainError(
      'ACCESS_DENIED',
      `The legacy system is authoritative for ${category} records in at least one scope, and this write's scope is only known to the owning module; a synchronized copy does not become an independent writer (§5.6).`,
      {
        nextAction: 'write_in_authoritative_system',
        details: {
          code: 'LEGACY_AUTHORITY',
          recordCategory: category,
          basis: 'assignment',
          assignmentId: legacy.id,
          scopeResolution: 'unproven',
        },
      },
    );
  }

  /**
   * The kernel's RECORD_AUTHORITY_PORT (K-11, IF-42; MIG-00): an in-process command of another
   * module (a scheduling port write, an outbox handler, a periodic job) asserts its record
   * category with the most specific scope it knows, inside its unit of work. With a scope the
   * most specific assignment in effect decides (§5.6); without one, any legacy assignment of the
   * category in effect refuses (§4.7 invariant 11: ambiguity refuses rather than duplicates).
   * Refusal: ACCESS_DENIED, `nextAction: write_in_authoritative_system`,
   * `details { code: 'LEGACY_AUTHORITY', recordCategory }`.
   */
  async assertNoLegacyAuthority(
    organizationId: string,
    category: ImportEntityTypeValue,
    scope?: RecordAuthorityScope,
    trx?: Trx,
  ): Promise<void> {
    if (scope && (scope.facilityId || scope.programId || scope.competitionId)) {
      await this.assertSportsparkAuthority(organizationId, category, scope, trx);
      return;
    }
    await this.assertNoLegacyAuthorityInEffect(organizationId, category, trx);
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  async list(
    principal: Principal,
    query: ListAuthorityAssignmentsQuery,
  ): Promise<Page<AuthorityAssignment>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MigrationActions.readAuthority, {
      type: 'authority_assignment',
      organizationId,
    });
    // MIG-01: keyset paging, newest first (created_at desc, id desc).
    const cursor = readKeysetCursor(query.cursor);
    let q = this.db
      .selectFrom('authority_assignments')
      .selectAll()
      .select(createdAtText('created_at').as('created_at_text'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.recordCategory) q = q.where('record_category', '=', query.recordCategory);
    if (query.at) {
      const at = new Date(query.at);
      q = q
        .where('effective_from', '<=', at)
        .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]));
    }
    if (cursor) q = q.where(afterKeyset('created_at', 'id', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map(toAuthorityAssignment), nextCursor: page.nextCursor };
  }

  async get(principal: Principal, id: string): Promise<AuthorityAssignment> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.notFound('authority assignment', id);
    await this.authorization.require(principal, MigrationActions.readAuthority, {
      type: 'authority_assignment',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    return toAuthorityAssignment(row);
  }

  async matrix(principal: Principal, query: AuthorityMatrixQuery): Promise<AuthorityMatrix> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MigrationActions.readAuthority, {
      type: 'authority_assignment',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const at = query.at ? new Date(query.at) : this.clock.now();
    const scope: AuthorityScopeRef = {
      facilityId: query.facilityId ?? null,
      programId: query.programId ?? null,
      competitionId: query.competitionId ?? null,
    };
    const entries: AuthorityResolution[] = [];
    for (const category of IMPORT_ENTITY_TYPES) {
      entries.push(await this.resolve(organizationId, category, scope, at));
    }
    return {
      at: at.toISOString(),
      facilityId: scope.facilityId ?? null,
      programId: scope.programId ?? null,
      competitionId: scope.competitionId ?? null,
      entries,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  async assign(
    principal: Principal,
    input: CreateAuthorityAssignmentInput,
    correlationId: string | null,
  ): Promise<AuthorityAssignment> {
    const organizationId = organizationOf(principal);
    const scope = input.scope ?? { kind: 'organization' as const };
    const facilityId = scope.kind === 'facility' ? scope.facilityId : null;
    const programId = scope.kind === 'program' ? scope.programId : null;
    const competitionId = scope.kind === 'competition' ? scope.competitionId : null;
    await this.authorization.require(principal, MigrationActions.assignAuthority, {
      type: 'authority_assignment',
      organizationId,
      facilityId,
    });
    if (input.recordCategory === 'future_schedule' && (programId || competitionId)) {
      // §5.6: shared pitches need one scheduling authority across migrated and other activities.
      throw errors.validation(
        'Schedule authority is assigned per organization or facility, never per program or competition (§5.6).',
        { path: 'scope' },
      );
    }
    const now = this.clock.now();
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
    if (effectiveFrom.getTime() < now.getTime()) {
      throw errors.validation('Authority is never assigned retroactively.', {
        path: 'effectiveFrom',
      });
    }
    if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
      throw errors.validation('effectiveTo must be after effectiveFrom.', { path: 'effectiveTo' });
    }
    return this.uow.run(async ({ trx }) => {
      const inEffect = await trx
        .selectFrom('authority_assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('record_category', '=', input.recordCategory)
        .where('scope_kind', '=', scope.kind)
        .where('facility_id', facilityId === null ? 'is' : '=', facilityId)
        .where('program_id', programId === null ? 'is' : '=', programId)
        .where('competition_id', competitionId === null ? 'is' : '=', competitionId)
        .where('effective_from', '<=', effectiveFrom)
        .where((eb) =>
          eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', effectiveFrom)]),
        )
        .forUpdate()
        .executeTakeFirst();
      let supersededId: string | null = null;
      if (inEffect) {
        if (!input.supersedes || input.supersedes.assignmentId !== inEffect.id) {
          throw errors.resourceConflict(
            'An authority assignment is in effect for this category and scope; name it to transfer authority.',
            { code: 'AUTHORITY_IN_EFFECT', assignmentId: inEffect.id, revision: inEffect.revision },
          );
        }
        if (input.supersedes.expectedRevision !== inEffect.revision) {
          throw errors.staleRevision(input.supersedes.expectedRevision, inEffect.revision);
        }
        if (inEffect.authoritative_system === input.authoritativeSystem) {
          throw errors.validation(
            `${input.authoritativeSystem} is already authoritative for this category and scope.`,
            { path: 'authoritativeSystem' },
          );
        }
        if (new Date(inEffect.effective_from).getTime() >= effectiveFrom.getTime()) {
          throw errors.resourceConflict(
            'The assignment in effect starts at the same instant; end it instead of superseding it.',
            { code: 'AUTHORITY_OVERLAP', assignmentId: inEffect.id },
          );
        }
        const ended = await trx
          .updateTable('authority_assignments')
          .set({
            effective_to: effectiveFrom,
            ended_at: now,
            ended_by: json(snapshotActor(principal)),
            end_reason: `Superseded: ${input.reason}`,
            revision: inEffect.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', inEffect.id)
          .where('revision', '=', inEffect.revision)
          .executeTakeFirst();
        if (Number(ended.numUpdatedRows) === 0) {
          throw errors.staleRevision(inEffect.revision, inEffect.revision + 1);
        }
        supersededId = inEffect.id;
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'migration.authority_ended',
          targetType: 'authority_assignment',
          targetId: inEffect.id,
          beforeRevision: inEffect.revision,
          afterRevision: inEffect.revision + 1,
          reason: input.reason,
          correlationId,
          details: { effectiveTo: effectiveFrom.toISOString(), supersededBy: 'transfer' },
        });
      } else if (input.supersedes) {
        throw errors.notFound('authority assignment in effect', input.supersedes.assignmentId);
      }
      const id = newId();
      try {
        await trx
          .insertInto('authority_assignments')
          .values({
            id,
            organization_id: organizationId,
            record_category: input.recordCategory,
            scope_kind: scope.kind,
            facility_id: facilityId,
            program_id: programId,
            competition_id: competitionId,
            authoritative_system: input.authoritativeSystem,
            effective_from: effectiveFrom,
            effective_to: effectiveTo,
            reason: input.reason,
            policy_references: input.policyReferences ?? [],
            approved_by: json(snapshotActor(principal)),
            approved_by_person_id: principal.personId,
            supersedes_assignment_id: supersededId,
            ended_at: null,
            ended_by: null,
            end_reason: null,
          })
          .execute();
      } catch (error) {
        if (isExclusionViolation(error)) {
          throw errors.resourceConflict(
            'Another assignment for this category and scope overlaps the requested period (one authority per instant, §4.7 invariant 11).',
            { code: 'AUTHORITY_OVERLAP' },
          );
        }
        if (isForeignKeyViolation(error)) throw errors.notFound('scope');
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MigrationActions.assignAuthority.id,
        targetType: 'authority_assignment',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId,
        details: {
          recordCategory: input.recordCategory,
          scopeKind: scope.kind,
          authoritativeSystem: input.authoritativeSystem,
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: effectiveTo?.toISOString() ?? null,
          supersedesAssignmentId: supersededId,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, MigrationEvents.authorityAssigned, {
        organizationId,
        aggregateType: 'authority_assignment',
        aggregateId: id,
        correlationId,
        payload: {
          assignmentId: id,
          recordCategory: input.recordCategory,
          scopeKind: scope.kind,
          scopeId: facilityId ?? programId ?? competitionId,
          authoritativeSystem: input.authoritativeSystem,
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: effectiveTo?.toISOString() ?? null,
          supersedesAssignmentId: supersededId,
        },
      });
      const row = await this.load(trx, organizationId, id);
      return toAuthorityAssignment(row as AssignmentRow);
    });
  }

  async end(
    principal: Principal,
    id: string,
    input: EndAuthorityAssignmentInput,
    correlationId: string | null,
  ): Promise<AuthorityAssignment> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      if (!current) throw errors.notFound('authority assignment', id);
      await this.authorization.require(principal, MigrationActions.assignAuthority, {
        type: 'authority_assignment',
        id,
        organizationId,
        facilityId: current.facility_id,
      });
      if (input.expectedRevision !== current.revision) {
        throw errors.staleRevision(input.expectedRevision, current.revision);
      }
      if (current.ended_at) throw errors.invalidTransition('AuthorityAssignment', 'ended', 'end');
      const now = this.clock.now();
      const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : now;
      if (effectiveTo.getTime() < now.getTime()) {
        throw errors.validation('Authority is never ended retroactively.', { path: 'effectiveTo' });
      }
      if (effectiveTo.getTime() <= new Date(current.effective_from).getTime()) {
        throw errors.validation('effectiveTo must be after the assignment starts.', {
          path: 'effectiveTo',
        });
      }
      if (
        current.effective_to &&
        effectiveTo.getTime() >= new Date(current.effective_to).getTime()
      ) {
        throw errors.validation('An assignment can only be shortened.', { path: 'effectiveTo' });
      }
      const updated = await trx
        .updateTable('authority_assignments')
        .set({
          effective_to: effectiveTo,
          ended_at: now,
          ended_by: json(snapshotActor(principal)),
          end_reason: input.reason,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        throw errors.staleRevision(current.revision, current.revision + 1);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'migration.authority_ended',
        targetType: 'authority_assignment',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
        details: { effectiveTo: effectiveTo.toISOString() },
      });
      await this.outbox.enqueue(trx, MigrationEvents.authorityEnded, {
        organizationId,
        aggregateType: 'authority_assignment',
        aggregateId: id,
        correlationId,
        payload: {
          assignmentId: id,
          recordCategory: current.record_category,
          effectiveTo: effectiveTo.toISOString(),
        },
      });
      const row = await this.load(trx, organizationId, id);
      return toAuthorityAssignment(row as AssignmentRow);
    });
  }

  private async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<AssignmentRow | undefined> {
    let q = db
      .selectFrom('authority_assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
}
