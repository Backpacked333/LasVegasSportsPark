import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type BracketNode,
  type BracketSource,
  type CreateBracketNodeInput,
  type Principal,
  type PublishBracketNodeInput,
  type SeedFromStandingsInput,
  type TiebreakExplanation,
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
import { loadSeasonRow, teamNamesOf, type Reader } from '../competition.queries';
import { organizationOf } from '../competition.shared';
import { readTarget } from './competitions.service';
import { StandingsService } from './standings.service';

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
    private readonly standings: StandingsService,
  ) {}

  /** Bracket nodes with their slot holders' team names (CMP-01: one join per page). */
  private async views(
    db: Reader,
    organizationId: string,
    rows: Array<Selectable<BracketNodesTable>>,
  ): Promise<BracketNode[]> {
    const names = await teamNamesOf(
      db,
      organizationId,
      rows.flatMap((r) => [r.home_entry_id, r.away_entry_id]),
    );
    return rows.map((row) => toBracketNode(row, names));
  }

  /**
   * `POST /v1/bracket-nodes/{id}/seed-from-standings` (CMP-10, CMP-15; SPK-COMP-001 bracket
   * progression, for every competition): an unpublished node's seeded slots take the entries at
   * the requested ranks of a division's (or a tournament pool's) standings. The table must be
   * final, every one of its fixtures holding an official result; an unresolved tie at a requested
   * rank refuses the seeding with the tied entries named (a draw of lots or a play-off is the
   * league's decision, never computed).
   */
  async seedFromStandings(
    principal: Principal,
    nodeId: string,
    input: SeedFromStandingsInput,
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
      if (node.published) throw errors.invalidTransition('BracketNode', 'published', 'seed');
      const rule = node.source_rule as { home: BracketSource; away: BracketSource };
      const seeds: Array<{
        slot: 'home' | 'away';
        teamEntryId: string;
        rank: number;
        divisionId: string | null;
        poolId: string | null;
      }> = [];
      for (const source of input.sources) {
        if (rule[source.slot].kind !== 'seed') {
          throw errors.validation('Only a seeded slot takes an entry from the standings.', {
            code: 'SLOT_NOT_SEEDED',
            slot: source.slot,
            sourceKind: rule[source.slot].kind,
          });
        }
        const table = source.poolId
          ? await this.standings.poolTable(trx, organizationId, source.poolId)
          : await this.standings.divisionTable(
              trx,
              organizationId,
              node.season_id,
              source.divisionId as string,
            );
        if (!table || table.seasonId !== node.season_id) {
          throw source.poolId
            ? errors.notFound('pool', source.poolId)
            : errors.notFound('division', source.divisionId as string);
        }
        if (table.pendingFixtureIds.length > 0) {
          throw new DomainError(
            'INVALID_TRANSITION',
            'The standings are not final: some fixtures have no official result yet.',
            {
              details: {
                code: 'STANDINGS_NOT_FINAL',
                pendingFixtureIds: table.pendingFixtureIds,
              },
            },
          );
        }
        const row = table.rows[source.rank - 1];
        if (!row) {
          throw errors.validation(`The standings have no rank ${source.rank}.`, {
            code: 'RANK_NOT_FOUND',
            rank: source.rank,
            entries: table.rows.length,
          });
        }
        const tied = unresolvedTieOf(table.tiebreakExplanations, row.teamEntryId);
        if (tied) {
          throw new DomainError(
            'INVALID_TRANSITION',
            `Rank ${source.rank} is an unresolved tie; the league decides it before seeding.`,
            { details: { code: 'UNRESOLVED_TIE', rank: source.rank, tiedEntryIds: tied } },
          );
        }
        seeds.push({
          slot: source.slot,
          teamEntryId: row.teamEntryId,
          rank: source.rank,
          divisionId: source.divisionId ?? null,
          poolId: source.poolId ?? null,
        });
      }
      const set: { home_entry_id?: string; away_entry_id?: string } = {};
      for (const seed of seeds) {
        if (seed.slot === 'home') set.home_entry_id = seed.teamEntryId;
        else set.away_entry_id = seed.teamEntryId;
      }
      const home = set.home_entry_id ?? node.home_entry_id;
      const away = set.away_entry_id ?? node.away_entry_id;
      if (home !== null && home === away) {
        throw errors.validation('Both slots would hold the same entry.', {
          code: 'SAME_ENTRY_BOTH_SLOTS',
          teamEntryId: home,
        });
      }
      const updated = await trx
        .updateTable('bracket_nodes')
        .set({ ...set, revision: node.revision + 1 })
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
        details: { operation: 'seed_from_standings', seeds },
      });
      await this.outbox.enqueue(trx, MatchEvents.bracketSeeded, {
        organizationId,
        aggregateType: 'bracket_node',
        aggregateId: nodeId,
        payload: { bracketNodeId: nodeId, seasonId: node.season_id, seeds },
        correlationId,
      });
      const [view] = await this.views(trx, organizationId, [updated]);
      return view as BracketNode;
    });
  }

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
        // Locked like result publication locks it, so linking and a first publication serialize.
        const fixture = await trx
          .selectFrom('fixtures')
          .select(['id', 'season_id'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.fixtureId)
          .forUpdate()
          .executeTakeFirst();
        if (!fixture || fixture.season_id !== seasonId)
          throw errors.notFound('fixture', input.fixtureId);
        // A node's fixture is a playoff game, which never counts in the league table. A fixture
        // whose result is already published counts there, so linking it would silently change
        // published standings (SPK-RESULT-001/004, §4.7 invariant 9).
        const published = await trx
          .selectFrom('result_revisions')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('fixture_id', '=', input.fixtureId)
          .where('status', 'in', ['official', 'superseded'])
          .executeTakeFirst();
        if (published) {
          throw errors.validation(
            'A fixture with a published result is part of the league standings and cannot be linked to a bracket node; create the playoff fixture for the node.',
            { code: 'fixture_result_published', fixtureId: input.fixtureId },
          );
        }
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
        details: {
          operation: 'create',
          seasonId,
          round: input.round,
          slot: input.slot,
          fixtureId: input.fixtureId ?? null,
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.bracketNodeCreated, {
        organizationId,
        aggregateType: 'bracket_node',
        aggregateId: id,
        payload: { bracketNodeId: id, seasonId, round: input.round },
        correlationId,
      });
      const [view] = await this.views(trx, organizationId, [row]);
      return view as BracketNode;
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
      const [view] = await this.views(trx, organizationId, [updated]);
      return view as BracketNode;
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
    return this.views(this.db, organizationId, visible);
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
   * SPK-RESULT-004: what a correction that changes the outcome of a bracket game would rewrite
   * beyond `correctionImpact`. The nodes fed by the game's node already act on the old outcome
   * once they have recorded a winner (the bracket went on) or have a fixture (its sides were set
   * from the old outcome and are not rewritten here), so changing them needs management review.
   */
  async revisionBlockers(
    db: Reader,
    organizationId: string,
    fixtureId: string,
  ): Promise<CorrectionImpact> {
    const node = await db
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .executeTakeFirst();
    if (!node) return { bracketNodeIds: [], fixtureIds: [] };
    const blocked = (await this.dependentsOf(db, node)).filter(
      (n) => n.published || n.winner_entry_id !== null || n.fixture_id !== null,
    );
    return {
      bracketNodeIds: blocked.map((n) => n.id).sort(),
      fixtureIds: blocked
        .map((n) => n.fixture_id)
        .filter((id): id is string => id !== null)
        .sort(),
    };
  }

  /**
   * Bracket progression (SPK-COMP-001 "bracket progression"): once a bracket game has an official
   * result with a winner (its first one, or a correction of an official result that had none), the
   * node records its winner and the nodes fed by it receive the winner or loser in a still-empty
   * slot. A correction that changes a recorded outcome goes through `reviseOutcome` when nothing
   * downstream acts on it, and through management review otherwise (SPK-RESULT-004).
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
    for (const dependent of await this.dependentsOf(trx, node)) {
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

  /**
   * SPK-RESULT-004 / SPK-COMP-001: a correction that changes the outcome of a bracket game whose
   * node and successors nobody acts on yet (none published, no winner recorded, no fixture; see
   * `revisionBlockers`) revises the progression instead of leaving the bracket on the old winner:
   * the node's winner, and each slot fed by the node that still holds the previous entry (or is
   * empty), take the new outcome. Every change is audited as `progress_revised` with the previous
   * and next values (§4.7 invariant 9).
   */
  async reviseOutcome(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      fixtureId: string;
      previous: { winnerEntryId: string | null; loserEntryId: string | null };
      next: { winnerEntryId: string | null; loserEntryId: string | null };
      correlationId: string | null;
      operationId: string | null;
    },
  ): Promise<string[]> {
    const { organizationId, previous, next } = input;
    const node = await trx
      .selectFrom('bracket_nodes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', input.fixtureId)
      .forUpdate()
      .executeTakeFirst();
    if (!node) return [];
    const audit = { ...input, operation: 'progress_revised', previous, next };
    const changed: string[] = [];
    if (node.winner_entry_id !== next.winnerEntryId) {
      await this.progress(trx, principal, node, { winner_entry_id: next.winnerEntryId }, audit);
      changed.push(node.id);
    }
    for (const dependent of await this.dependentsOf(trx, node)) {
      const rule = dependent.source_rule as { home: BracketSource; away: BracketSource };
      // Both sides are computed before writing, so a winner/loser swap never collides.
      const revised = (source: BracketSource, current: string | null): string | null => {
        const fed =
          source.kind === 'winner_of' && source.nodeId === node.id
            ? { from: previous.winnerEntryId, to: next.winnerEntryId }
            : source.kind === 'loser_of' && source.nodeId === node.id
              ? { from: previous.loserEntryId, to: next.loserEntryId }
              : null;
        if (!fed || (current !== null && current !== fed.from)) return current;
        return fed.to;
      };
      const home = revised(rule.home, dependent.home_entry_id);
      const away = revised(rule.away, dependent.away_entry_id);
      const set: { home_entry_id?: string | null; away_entry_id?: string | null } = {};
      if (home !== dependent.home_entry_id) set.home_entry_id = home;
      if (away !== dependent.away_entry_id) set.away_entry_id = away;
      if (Object.keys(set).length === 0) continue;
      const locked = await this.load(trx, organizationId, dependent.id, { forUpdate: true });
      if (!locked) continue;
      await this.progress(trx, principal, locked, set, audit);
      changed.push(dependent.id);
    }
    return changed;
  }

  /** The nodes fed (through winner_of / loser_of) directly by the node. */
  private async dependentsOf(
    db: Reader,
    node: Selectable<BracketNodesTable>,
  ): Promise<Array<Selectable<BracketNodesTable>>> {
    return (await this.seasonNodes(db, node.organization_id, [node.season_id])).filter((n) =>
      sourcesOf(n).some(
        (source) =>
          (source.kind === 'winner_of' || source.kind === 'loser_of') && source.nodeId === node.id,
      ),
    );
  }

  private async progress(
    trx: Trx,
    principal: Principal,
    node: Selectable<BracketNodesTable>,
    set: {
      winner_entry_id?: string | null;
      home_entry_id?: string | null;
      away_entry_id?: string | null;
    },
    input: {
      fixtureId: string;
      correlationId: string | null;
      operationId: string | null;
      operation?: string;
      previous?: { winnerEntryId: string | null; loserEntryId: string | null };
      next?: { winnerEntryId: string | null; loserEntryId: string | null };
    },
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
      details: {
        operation: input.operation ?? 'progress',
        fixtureId: input.fixtureId,
        ...set,
        ...(input.previous ? { previousOutcome: input.previous, nextOutcome: input.next } : {}),
      },
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

/** The still-tied entries of an unresolved tie the entry is part of, or null (CMP-10). */
export function unresolvedTieOf(
  explanations: readonly TiebreakExplanation[],
  teamEntryId: string,
): string[] | null {
  for (const explanation of explanations) {
    if (explanation.resolved) continue;
    for (const step of explanation.steps) {
      if (step.outcome !== 'unresolved') continue;
      const ids = step.values.map((v) => v.teamEntryId);
      if (ids.includes(teamEntryId)) return [...ids].sort();
    }
  }
  return null;
}
