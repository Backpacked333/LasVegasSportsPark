import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type BracketNode,
  type BracketSource,
  type CreateBracketNodeInput,
  type Principal,
  type PublishBracketNodeInput,
} from '@sportspark/contracts';
import { json, type BracketNodesTable, type Db } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { toBracketNode } from '../competition-matches.shared';
import { loadSeasonRow, type Reader } from '../competition.queries';
import { organizationOf } from '../competition.shared';
import { readTarget } from './competitions.service';

export interface CorrectionImpact {
  /** Published nodes played by, or fed by the outcome of, the fixture. */
  bracketNodeIds: string[];
  /** Downstream fixtures already played or forfeited that depend on the fixture's outcome. */
  fixtureIds: string[];
}

/**
 * Bracket nodes (§4.4 BracketNode): slots of a playoff round fed by seeds or by another node's
 * winner or loser. Publication makes a node part of published history, so a correction of a
 * feeding result requires management review (SPK-RESULT-004, SPK-AT-014) instead of a rewrite.
 */
@Injectable()
export class BracketsService {
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
    seasonId: string,
    input: CreateBracketNodeInput,
    correlationId: string | null,
  ): Promise<BracketNode> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const season = await loadSeasonRow(trx, organizationId, seasonId);
      if (!season) throw errors.notFound('season', seasonId);
      await this.authorization.require(principal, MatchActions.manageBrackets, {
        type: 'bracket_node',
        organizationId,
      });
      for (const source of [input.home, input.away]) {
        if (source.kind === 'winner_of' || source.kind === 'loser_of') {
          const fed = await this.load(trx, organizationId, source.nodeId);
          if (!fed || fed.season_id !== seasonId)
            throw errors.notFound('bracket_node', source.nodeId);
        }
      }
      if (input.fixtureId) {
        const fixture = await trx
          .selectFrom('fixtures')
          .select(['id', 'season_id'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.fixtureId)
          .executeTakeFirst();
        if (!fixture || fixture.season_id !== seasonId)
          throw errors.notFound('fixture', input.fixtureId);
      }
      const id = newId();
      const row = await trx
        .insertInto('bracket_nodes')
        .values({
          id,
          organization_id: organizationId,
          season_id: seasonId,
          division_id: input.divisionId ?? null,
          name: input.name ?? null,
          round: input.round,
          slot: input.slot,
          source_rule: json({ home: input.home, away: input.away }),
          home_entry_id: input.homeEntryId ?? null,
          away_entry_id: input.awayEntryId ?? null,
          fixture_id: input.fixtureId ?? null,
          winner_entry_id: null,
          published_at: null,
          published_by: null,
          created_by: json(snapshotActor(principal)),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageBrackets.id,
        targetType: 'bracket_node',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'create', seasonId, round: input.round, slot: input.slot },
      });
      await this.outbox.enqueue(trx, MatchEvents.bracketNodeCreated, {
        organizationId,
        aggregateType: 'bracket_node',
        aggregateId: id,
        payload: { bracketNodeId: id, seasonId, round: input.round },
        correlationId,
      });
      return toBracketNode(row);
    });
  }

  async publish(
    principal: Principal,
    nodeId: string,
    input: PublishBracketNodeInput,
    correlationId: string | null,
  ): Promise<BracketNode> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const node = await this.load(trx, organizationId, nodeId, { forUpdate: true });
      if (!node) throw errors.notFound('bracket_node', nodeId);
      await this.authorization.require(principal, MatchActions.manageBrackets, {
        type: 'bracket_node',
        id: nodeId,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, node.revision);
      if (node.published) throw errors.invalidTransition('BracketNode', 'published', 'publish');
      const now = this.clock.now();
      const updated = await trx
        .updateTable('bracket_nodes')
        .set({
          published: true,
          published_at: now,
          published_by: json(snapshotActor(principal)),
          revision: node.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', nodeId)
        .where('revision', '=', node.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageBrackets.id,
        targetType: 'bracket_node',
        targetId: nodeId,
        beforeRevision: node.revision,
        afterRevision: updated.revision,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'publish' },
      });
      await this.outbox.enqueue(trx, MatchEvents.bracketNodePublished, {
        organizationId,
        aggregateType: 'bracket_node',
        aggregateId: nodeId,
        payload: { bracketNodeId: nodeId, seasonId: node.season_id, fixtureId: node.fixture_id },
        correlationId,
      });
      return toBracketNode(updated);
    });
  }

  async list(
    principal: Principal,
    seasonId: string,
    query: { divisionId?: string | undefined },
  ): Promise<BracketNode[]> {
    const organizationId = organizationOf(principal);
    const season = await loadSeasonRow(this.db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    await this.authorization.require(
      principal,
      MatchActions.readBrackets,
      readTarget(principal, 'season', seasonId, organizationId),
    );
    let q = this.db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .orderBy('round')
      .orderBy('slot');
    if (query.divisionId) q = q.where('division_id', '=', query.divisionId);
    const rows = await q.execute();
    // Customers see published nodes only; staff see the whole bracket.
    const visible =
      principal.kind === 'staff' || principal.kind === 'system'
        ? rows
        : rows.filter((r) => r.published);
    return visible.map(toBracketNode);
  }

  /**
   * SPK-RESULT-004 / SPK-AT-014: whether correcting the fixture's official result would touch a
   * published bracket node or a downstream game already played. Nodes referencing the fixture's
   * node through winner_of/loser_of are followed transitively.
   */
  async correctionImpact(
    db: Reader,
    organizationId: string,
    fixtureId: string,
  ): Promise<CorrectionImpact> {
    const nodes = await db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .execute();
    if (nodes.length === 0) return { bracketNodeIds: [], fixtureIds: [] };
    const all = await db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', 'in', [...new Set(nodes.map((n) => n.season_id))])
      .execute();
    const affected = new Map<string, Selectable<BracketNodesTable>>();
    const frontier = [...nodes];
    while (frontier.length > 0) {
      const current = frontier.pop() as Selectable<BracketNodesTable>;
      if (affected.has(current.id)) continue;
      affected.set(current.id, current);
      for (const candidate of all) {
        const rule = candidate.source_rule as { home: BracketSource; away: BracketSource };
        const feeds = [rule.home, rule.away].some(
          (s) => (s.kind === 'winner_of' || s.kind === 'loser_of') && s.nodeId === current.id,
        );
        if (feeds) frontier.push(candidate);
      }
    }
    const bracketNodeIds = [...affected.values()].filter((n) => n.published).map((n) => n.id);
    const downstreamFixtureIds = [...affected.values()]
      .filter((n) => !nodes.some((origin) => origin.id === n.id) && n.fixture_id !== null)
      .map((n) => n.fixture_id as string);
    let fixtureIds: string[] = [];
    if (downstreamFixtureIds.length > 0) {
      const played = await db
        .selectFrom('fixtures')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', 'in', downstreamFixtureIds)
        .where('status', 'in', ['played', 'forfeit'])
        .execute();
      fixtureIds = played.map((f) => f.id);
    }
    return { bracketNodeIds, fixtureIds };
  }

  private async load(
    db: Trx | Db,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Selectable<BracketNodesTable> | null> {
    let q = db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (options.forUpdate) q = q.forUpdate();
    return (await q.executeTakeFirst()) ?? null;
  }
}
