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

function sourcesOf(node: Selectable<BracketNodesTable>): BracketSource[] {
  const rule = node.source_rule as { home: BracketSource; away: BracketSource };
  return [rule.home, rule.away];
}

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
   * SPK-RESULT-004 / SPK-AT-014: whether correcting the official result of a fixture that is itself
   * played in the bracket would touch published history: the published nodes it plays or feeds
   * (through winner_of / loser_of, transitively) and downstream bracket games already played.
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
    const all = await this.seasonNodes(db, organizationId, [
      ...new Set(nodes.map((n) => n.season_id)),
    ]);
    return this.expand(db, organizationId, all, nodes, { originsArePlayed: true });
  }

  /** Whether the fixture is played in a bracket node (playoff game) rather than the league phase. */
  async isBracketFixture(db: Reader, organizationId: string, fixtureId: string): Promise<boolean> {
    const row = await db
      .selectFrom('bracket_nodes')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The highest seed used by a published node of the season and division scope (seeds come from
   * the standings of that scope), or 0 when no published node is seeded from standings.
   */
  async publishedSeedDepth(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisionId: string | null,
  ): Promise<number> {
    let depth = 0;
    for (const node of await this.scopeNodes(db, organizationId, seasonId, divisionId)) {
      if (!node.published) continue;
      for (const source of sourcesOf(node)) {
        if (source.kind === 'seed') depth = Math.max(depth, source.seed);
      }
    }
    return depth;
  }

  /**
   * SPK-RESULT-004 / SPK-AT-014 for a league-phase correction: when the corrected standings change
   * the entry holding a seed that a published node draws from, that node, every node it feeds and
   * the downstream games already played are affected.
   */
  async seedImpact(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisionId: string | null,
    changedSeeds: ReadonlySet<number>,
  ): Promise<CorrectionImpact> {
    if (changedSeeds.size === 0) return { bracketNodeIds: [], fixtureIds: [] };
    const scope = await this.scopeNodes(db, organizationId, seasonId, divisionId);
    const origins = scope.filter(
      (n) =>
        n.published &&
        sourcesOf(n).some((source) => source.kind === 'seed' && changedSeeds.has(source.seed)),
    );
    if (origins.length === 0) return { bracketNodeIds: [], fixtureIds: [] };
    const all = await this.seasonNodes(db, organizationId, [seasonId]);
    return this.expand(db, organizationId, all, origins, { originsArePlayed: false });
  }

  /**
   * Bracket progression (SPK-COMP-001 "bracket progression"): once a bracket game's first official
   * result is published, the node records its winner and the nodes fed by it receive the winner
   * or loser in a still-empty slot. A correction never moves entries here: it goes through
   * management review (SPK-RESULT-004).
   */
  async recordOutcome(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      fixtureId: string;
      winnerEntryId: string | null;
      loserEntryId: string | null;
      correlationId: string | null;
      operationId: string | null;
    },
  ): Promise<string[]> {
    const { organizationId } = input;
    const node = await trx
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', input.fixtureId)
      .forUpdate()
      .executeTakeFirst();
    if (!node || !input.winnerEntryId) return [];
    const changed: string[] = [];
    if (node.winner_entry_id === null) {
      await this.progress(trx, principal, node, { winner_entry_id: input.winnerEntryId }, input);
      changed.push(node.id);
    }
    const dependents = (await this.seasonNodes(trx, organizationId, [node.season_id])).filter((n) =>
      sourcesOf(n).some(
        (source) =>
          (source.kind === 'winner_of' || source.kind === 'loser_of') && source.nodeId === node.id,
      ),
    );
    for (const dependent of dependents) {
      const rule = dependent.source_rule as { home: BracketSource; away: BracketSource };
      const entryFor = (source: BracketSource): string | null =>
        source.kind === 'winner_of' && source.nodeId === node.id
          ? input.winnerEntryId
          : source.kind === 'loser_of' && source.nodeId === node.id
            ? input.loserEntryId
            : null;
      const set: { home_entry_id?: string; away_entry_id?: string } = {};
      const home = entryFor(rule.home);
      const away = entryFor(rule.away);
      if (home && dependent.home_entry_id === null && dependent.away_entry_id !== home) {
        set.home_entry_id = home;
      }
      if (away && dependent.away_entry_id === null && dependent.home_entry_id !== away) {
        set.away_entry_id = away;
      }
      if (Object.keys(set).length === 0) continue;
      const locked = await this.load(trx, organizationId, dependent.id, { forUpdate: true });
      if (!locked) continue;
      await this.progress(trx, principal, locked, set, input);
      changed.push(dependent.id);
    }
    return changed;
  }

  private async progress(
    trx: Trx,
    principal: Principal,
    node: Selectable<BracketNodesTable>,
    set: { winner_entry_id?: string; home_entry_id?: string; away_entry_id?: string },
    input: { fixtureId: string; correlationId: string | null; operationId: string | null },
  ): Promise<void> {
    await trx
      .updateTable('bracket_nodes')
      .set({ ...set, revision: node.revision + 1 })
      .where('organization_id', '=', node.organization_id)
      .where('id', '=', node.id)
      .where('revision', '=', node.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId: node.organization_id,
      actor: principal,
      action: MatchActions.manageBrackets.id,
      targetType: 'bracket_node',
      targetId: node.id,
      beforeRevision: node.revision,
      afterRevision: node.revision + 1,
      correlationId: input.correlationId,
      operationId: input.operationId,
      details: { operation: 'progress', fixtureId: input.fixtureId, ...set },
    });
  }

  private async scopeNodes(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisionId: string | null,
  ): Promise<Array<Selectable<BracketNodesTable>>> {
    let q = db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId);
    q = divisionId ? q.where('division_id', '=', divisionId) : q.where('division_id', 'is', null);
    return q.execute();
  }

  private async seasonNodes(
    db: Reader,
    organizationId: string,
    seasonIds: string[],
  ): Promise<Array<Selectable<BracketNodesTable>>> {
    return db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', 'in', seasonIds)
      .execute();
  }

  /** The origins plus every node they feed (transitively): published ones and played games. */
  private async expand(
    db: Reader,
    organizationId: string,
    all: Array<Selectable<BracketNodesTable>>,
    origins: Array<Selectable<BracketNodesTable>>,
    options: { originsArePlayed: boolean },
  ): Promise<CorrectionImpact> {
    const affected = new Map<string, Selectable<BracketNodesTable>>();
    const frontier = [...origins];
    while (frontier.length > 0) {
      const current = frontier.pop() as Selectable<BracketNodesTable>;
      if (affected.has(current.id)) continue;
      affected.set(current.id, current);
      for (const candidate of all) {
        const feeds = sourcesOf(candidate).some(
          (s) => (s.kind === 'winner_of' || s.kind === 'loser_of') && s.nodeId === current.id,
        );
        if (feeds) frontier.push(candidate);
      }
    }
    const bracketNodeIds = [...affected.values()].filter((n) => n.published).map((n) => n.id);
    // When the origins are the corrected game's own nodes, their fixture is the corrected one.
    const downstreamFixtureIds = [...affected.values()]
      .filter(
        (n) => !(options.originsArePlayed && origins.some((o) => o.id === n.id)) && n.fixture_id,
      )
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
      fixtureIds = played.map((f) => f.id).sort();
    }
    return { bracketNodeIds: bracketNodeIds.sort(), fixtureIds };
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
