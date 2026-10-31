import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Competition,
  type CreateCompetitionInput,
  type CreateRuleSetInput,
  type ListCompetitionsQuery,
  type ListRuleSetsQuery,
  type Principal,
  type RuleSet,
  type UpdateCompetitionInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type AuthorizationTargetInput,
  type Clock,
} from '../../../kernel';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { isStaffLike, organizationOf, toCompetition, toRuleSet } from '../competition.shared';
import { CompetitionMachine, eventTo } from '../competition.state-machines';
import { loadRuleSetRow } from '../competition.queries';

/** Target for reads that any member of the organization may perform (customers read as themselves). */
export function readTarget(
  principal: Principal,
  type: string,
  id: string | null,
  organizationId: string,
): AuthorizationTargetInput {
  return {
    type,
    id,
    organizationId,
    subjectPersonIds: isStaffLike(principal) || !principal.personId ? [] : [principal.personId],
  };
}

/**
 * Competitions and immutable rule-set versions (SPK-COMP-001/002). A rule set is never edited:
 * posting the same name creates the next version, which seasons adopt explicitly.
 */
@Injectable()
export class CompetitionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async create(
    principal: Principal,
    input: CreateCompetitionInput,
    correlationId: string | null,
  ): Promise<Competition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
      type: 'competition',
      organizationId,
    });
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      try {
        await trx
          .insertInto('competitions')
          .values({
            id,
            organization_id: organizationId,
            name: input.name,
            kind: input.kind,
            sport_format: input.sportFormat,
            description: input.description ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A competition with this name already exists.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'competition',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { operation: 'create', kind: input.kind, sportFormat: input.sportFormat },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.competitionCreated, {
        organizationId,
        aggregateType: 'competition',
        aggregateId: id,
        payload: { competitionId: id, kind: input.kind, sportFormat: input.sportFormat },
        correlationId,
      });
      const row = await trx
        .selectFrom('competitions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toCompetition(row);
    });
  }

  async get(principal: Principal, id: string): Promise<Competition> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('competitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('competition', id);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'competition', id, organizationId),
    );
    return toCompetition(row);
  }

  async list(principal: Principal, query: ListCompetitionsQuery): Promise<Competition[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'competition', null, organizationId),
    );
    let q = this.db
      .selectFrom('competitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name');
    if (query.status) q = q.where('status', '=', query.status);
    if (query.sportFormat) q = q.where('sport_format', '=', query.sportFormat);
    return (await q.execute()).map(toCompetition);
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateCompetitionInput,
    correlationId: string | null,
  ): Promise<Competition> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('competitions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('competition', id);
      await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
        type: 'competition',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      let status = current.status;
      if (input.status !== undefined && input.status !== current.status) {
        status = CompetitionMachine.next(
          current.status,
          eventTo(CompetitionMachine, current.status, input.status),
        );
      }
      try {
        await trx
          .updateTable('competitions')
          .set({
            name: input.name ?? current.name,
            description: input.description === undefined ? current.description : input.description,
            status,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', current.revision)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A competition with this name already exists.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'competition',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'update', fields: Object.keys(input), status },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.competitionUpdated, {
        organizationId,
        aggregateType: 'competition',
        aggregateId: id,
        payload: { competitionId: id, status, revision: current.revision + 1 },
        correlationId,
      });
      const row = await trx
        .selectFrom('competitions')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return toCompetition(row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Rule sets (SPK-COMP-002): immutable versions; a new version supersedes the latest by name.
  // -------------------------------------------------------------------------------------------
  async createRuleSet(
    principal: Principal,
    input: CreateRuleSetInput,
    correlationId: string | null,
  ): Promise<RuleSet> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
      type: 'rule_set',
      organizationId,
    });
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      const latest = await trx
        .selectFrom('rule_sets')
        .select(['id', 'format', 'version'])
        .where('organization_id', '=', organizationId)
        .where('name', '=', input.name)
        .orderBy('version', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (latest && latest.format !== input.format) {
        throw errors.validation(
          `Rule set '${input.name}' is a ${latest.format} rule set; a new version keeps its format.`,
          { format: latest.format },
        );
      }
      const version = latest ? latest.version + 1 : 1;
      try {
        await trx
          .insertInto('rule_sets')
          .values({
            id,
            organization_id: organizationId,
            name: input.name,
            format: input.format,
            version,
            content: json(input.content),
            supersedes_rule_set_id: latest?.id ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'Another version of this rule set was created concurrently; retry.',
          );
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'rule_set',
        targetId: id,
        afterRevision: version,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'create_version',
          name: input.name,
          format: input.format,
          version,
          supersedes: latest?.id ?? null,
          policyReferences: input.policyReferences ?? [],
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.ruleSetCreated, {
        organizationId,
        aggregateType: 'rule_set',
        aggregateId: id,
        payload: {
          ruleSetId: id,
          name: input.name,
          format: input.format,
          version,
          supersedesRuleSetId: latest?.id ?? null,
        },
        correlationId,
      });
      const row = await loadRuleSetRow(trx, organizationId, id);
      if (!row) throw errors.internal('rule set vanished after insert');
      return toRuleSet(row);
    });
  }

  async getRuleSet(principal: Principal, id: string): Promise<RuleSet> {
    const organizationId = organizationOf(principal);
    const row = await loadRuleSetRow(this.db, organizationId, id);
    if (!row) throw errors.notFound('rule_set', id);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'rule_set', id, organizationId),
    );
    return toRuleSet(row);
  }

  async listRuleSets(principal: Principal, query: ListRuleSetsQuery): Promise<RuleSet[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'rule_set', null, organizationId),
    );
    let q = this.db
      .selectFrom('rule_sets')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('version', 'desc');
    if (query.name) q = q.where('name', '=', query.name);
    if (query.format) q = q.where('format', '=', query.format);
    if (query.latestOnly) {
      q = q.where(
        sql<boolean>`version = (select max(v.version) from rule_sets v where v.organization_id = rule_sets.organization_id and v.name = rule_sets.name)`,
      );
    }
    return (await q.execute()).map(toRuleSet);
  }

  /** Current instant for callers that compute windows (kept here so controllers never read the clock). */
  now(): Date {
    return this.clock.now();
  }
}
