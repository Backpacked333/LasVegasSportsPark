import { Injectable } from '@nestjs/common';
import { errors, type ReportRow, type RetentionCohort } from '@sportspark/contracts';
import { cohortOutcome } from '../calculators/cohorts';
import { column, type ReportContext, type ReportDefinition } from '../engine/report-definition';
import { ReportingActions } from '../reporting.actions';
import { metricValue } from '../reporting.shared';

interface RetentionParams {
  cohort: RetentionCohort;
  anchorSeasonId?: string;
  comparisonSeasonId?: string;
  anchorFrom?: string;
  anchorTo?: string;
  comparisonFrom?: string;
  comparisonTo?: string;
  programId?: string;
  excludeNotOffered?: boolean;
}

interface Period {
  from: string;
  to: string;
}

const METRIC: Record<RetentionCohort, string> = {
  adult_teams: 'MET-079',
  individual_players: 'MET-080',
  youth_participants: 'MET-081',
  households: 'MET-082',
  rental_customers: 'MET-083',
};

const LABEL: Record<RetentionCohort, string> = {
  adult_teams: 'Adult team renewal rate',
  individual_players: 'Individual player return rate',
  youth_participants: 'Youth participant return rate',
  households: 'Household repeat purchase rate',
  rental_customers: 'Rental customer return rate',
};

const heldAt = (asOf: Date, confirmedAt: Date | null, ended: ReadonlyArray<Date | null>) =>
  confirmedAt !== null &&
  new Date(confirmedAt) <= asOf &&
  ended.every((t) => t === null || new Date(t) > asOf);

/**
 * Retention by cohort (SPK-REPORT-005, metric dictionary rules K1 to K6). One request evaluates
 * exactly one cohort: adult teams, individual players, youth participants, households and rental
 * customers are different facts and are never summed (K1) — a household that buys again is not a
 * returning participant. Members are continuing identities (K5): a team (not its season entry), a
 * person after merge resolution (G7), a household record, a paying person.
 */
@Injectable()
export class RetentionReport {
  readonly definition: ReportDefinition<'retention'> = {
    key: 'retention',
    title: 'Retention by cohort',
    requirementIds: ['SPK-REPORT-005', '§1.2'],
    viewAction: ReportingActions.viewRetention,
    exportAction: ReportingActions.exportOperational,
    scope: 'organization',
    pointInTime: 'partial',
    pointInTimeNote:
      'Approvals, confirmations, cancellations, transfers, fulfilments and refunds after the as-of instant are ignored (their instants are recorded); roster membership status is taken as it stands now.',
    compute: async (ctx, params) => this.compute(ctx, params),
  };

  private async compute(ctx: ReportContext, params: RetentionParams) {
    const cohort = params.cohort;
    let anchor: Set<string>;
    let comparison: Set<string>;
    let notOffered = new Set<string>();
    let anchorLabel: string;
    let comparisonLabel: string;
    const disclosures: string[] = [
      'One cohort per report: cohorts are separate metrics and are never summed (K1).',
      'No member is named: the report gives counts only (rule G9).',
    ];

    if (cohort === 'adult_teams' || cohort === 'individual_players') {
      if (!params.anchorSeasonId || !params.comparisonSeasonId) {
        throw errors.validation('This cohort needs anchorSeasonId and comparisonSeasonId (K2).');
      }
      if (params.anchorSeasonId === params.comparisonSeasonId) {
        throw errors.validation('The comparison season must differ from the anchor season.');
      }
      const seasons = await ctx.db
        .selectFrom('reporting_seasons_v')
        .select(['season_id', 'season_name', 'starts_on'])
        .where('organization_id', '=', ctx.organizationId)
        .where('season_id', 'in', [params.anchorSeasonId, params.comparisonSeasonId])
        .execute();
      const anchorSeason = seasons.find((s) => s.season_id === params.anchorSeasonId);
      const comparisonSeason = seasons.find((s) => s.season_id === params.comparisonSeasonId);
      if (!anchorSeason || !comparisonSeason) throw errors.notFound('season');
      anchorLabel = `${anchorSeason.season_name} (${anchorSeason.season_id})`;
      comparisonLabel = `${comparisonSeason.season_name} (${comparisonSeason.season_id})`;
      disclosures.push(
        `Comparable season named by the request: ${anchorSeason.season_name} → ${comparisonSeason.season_name} (K2; comparability is DEC-002 / DEC-048).`,
      );
      if (cohort === 'adult_teams') {
        anchor = await this.teamsOf(ctx, params.anchorSeasonId);
        comparison = await this.teamsOf(ctx, params.comparisonSeasonId);
        disclosures.push(
          'A team is its continuing identity, not its season entry (K5); only approved entries qualify (K3).',
        );
      } else {
        anchor = await this.playersOf(ctx, params.anchorSeasonId);
        comparison = await this.playersOf(ctx, params.comparisonSeasonId);
        disclosures.push(
          'Adult players with an active roster membership on an approved entry, or a confirmed individual-league enrollment in the season offering, regardless of who paid; guests and substitutes do not qualify (K3); merged duplicates count once (G7).',
        );
      }
    } else {
      const periods = this.periods(params);
      anchorLabel = `${periods.anchor.from}..${periods.anchor.to}`;
      comparisonLabel = `${periods.comparison.from}..${periods.comparison.to}`;
      disclosures.push(
        `Anchor period ${anchorLabel} and comparison period ${comparisonLabel} by offering start date, named by the request (K2; comparability is DEC-003).`,
      );
      if (cohort === 'youth_participants') {
        anchor = await this.youthOf(ctx, periods.anchor, params.programId);
        comparison = await this.youthOf(ctx, periods.comparison, params.programId);
        if (params.programId) {
          const offered = await ctx.db
            .selectFrom('reporting_offerings_v')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('organization_id', '=', ctx.organizationId)
            .where('program_id', '=', params.programId)
            .where('starts_on', '>=', periods.comparison.from)
            .where('starts_on', '<=', periods.comparison.to)
            .executeTakeFirst();
          if (Number(offered?.n ?? 0) === 0) notOffered = new Set(anchor);
          disclosures.push(
            'When the program offers nothing in the comparison period, its anchor members are counted as not offered (K4).',
          );
        }
        disclosures.push(
          'Children with a confirmed or completed enrollment; trials and makeups do not qualify (K3). Children who aged out are not detected (age bands are DEC-003).',
        );
      } else if (cohort === 'households') {
        anchor = await this.householdsOf(ctx, periods.anchor);
        comparison = await this.householdsOf(ctx, periods.comparison);
        disclosures.push(
          'A household returned when a member paid a fulfilled order for an offering starting in the comparison period; this is a purchase metric, not a participation metric (SPK-REPORT-005).',
        );
      } else {
        anchor = await this.rentalPayersOf(ctx, periods.anchor);
        comparison = await this.rentalPayersOf(ctx, periods.comparison);
        disclosures.push(
          'Rental customers are the paying persons of confirmed rental enrollments (K5).',
        );
      }
    }

    const outcome = cohortOutcome(anchor, comparison, {
      notOffered,
      excludeNotOffered: params.excludeNotOffered ?? false,
    });
    disclosures.push(
      params.excludeNotOffered
        ? 'Members who could not return (not offered) are excluded from the denominator, as requested (K4).'
        : 'Members who could not return (not offered) stay in the denominator and are shown separately (K4).',
    );
    const metric = METRIC[cohort];
    const row: ReportRow = {
      cohort,
      anchor: anchorLabel,
      comparison: comparisonLabel,
      cohortSize: outcome.cohortSize,
      returned: outcome.returned,
      notOffered: outcome.notOffered,
      denominator: outcome.denominator,
      returnRate: outcome.rate === null ? null : Math.round(outcome.rate * 10_000) / 10_000,
      newInComparison: outcome.newInComparison,
    };
    return {
      scope: { from: null, to: null },
      values: [
        metricValue(metric, LABEL[cohort], 'ratio', row.returnRate as number | null, {
          dimensions: { cohort },
          unavailableReason: 'the anchor cohort is empty',
        }),
        metricValue(metric, 'Cohort size', 'count', outcome.cohortSize, { dimensions: { cohort } }),
        metricValue(metric, 'Returned', 'count', outcome.returned, { dimensions: { cohort } }),
        metricValue(metric, 'Not offered', 'count', outcome.notOffered, { dimensions: { cohort } }),
      ],
      columns: [
        column('cohort', 'Cohort'),
        column('anchor', 'Anchor'),
        column('comparison', 'Comparison'),
        column('cohortSize', 'Cohort size', 'count'),
        column('returned', 'Returned', 'count'),
        column('notOffered', 'Not offered', 'count'),
        column('denominator', 'Denominator', 'count'),
        column('returnRate', 'Return rate', 'ratio'),
        column('newInComparison', 'New in comparison period', 'count'),
      ],
      rows: [row],
      disclosures,
    };
  }

  private periods(params: RetentionParams): { anchor: Period; comparison: Period } {
    const { anchorFrom, anchorTo, comparisonFrom, comparisonTo } = params;
    if (!anchorFrom || !anchorTo || !comparisonFrom || !comparisonTo) {
      throw errors.validation(
        'This cohort needs anchorFrom, anchorTo, comparisonFrom and comparisonTo (K2).',
      );
    }
    if (anchorFrom > anchorTo || comparisonFrom > comparisonTo) {
      throw errors.validation('A period must not end before it starts.');
    }
    if (comparisonFrom <= anchorTo) {
      throw errors.validation('The comparison period must start after the anchor period ends.');
    }
    return {
      anchor: { from: anchorFrom, to: anchorTo },
      comparison: { from: comparisonFrom, to: comparisonTo },
    };
  }

  private async teamsOf(ctx: ReportContext, seasonId: string): Promise<Set<string>> {
    const rows = await ctx.db
      .selectFrom('reporting_team_entries_v')
      .select(['team_id', 'approved_at'])
      .where('organization_id', '=', ctx.organizationId)
      .where('season_id', '=', seasonId)
      .where('status', '=', 'approved')
      .execute();
    return new Set(
      rows
        .filter((r) => r.approved_at !== null && new Date(r.approved_at) <= ctx.asOf)
        .map((r) => r.team_id),
    );
  }

  private async playersOf(ctx: ReportContext, seasonId: string): Promise<Set<string>> {
    const entries = await ctx.db
      .selectFrom('reporting_team_entries_v')
      .select(['team_entry_id', 'approved_at'])
      .where('organization_id', '=', ctx.organizationId)
      .where('season_id', '=', seasonId)
      .where('status', '=', 'approved')
      .execute();
    const entryIds = entries
      .filter((e) => e.approved_at !== null && new Date(e.approved_at) <= ctx.asOf)
      .map((e) => e.team_entry_id);
    const players = new Set<string>();
    if (entryIds.length > 0) {
      const roster = await ctx.db
        .selectFrom('reporting_roster_memberships_v')
        .select(['canonical_person_id', 'effective_from'])
        .where('organization_id', '=', ctx.organizationId)
        .where('team_entry_id', 'in', entryIds)
        .where('status', '=', 'active')
        .where('person_kind', '=', 'adult')
        .execute();
      for (const m of roster)
        if (new Date(m.effective_from) <= ctx.asOf) players.add(m.canonical_person_id);
    }
    const season = await ctx.db
      .selectFrom('reporting_seasons_v')
      .select(['registration_offering_ref'])
      .where('organization_id', '=', ctx.organizationId)
      .where('season_id', '=', seasonId)
      .executeTakeFirst();
    if (season?.registration_offering_ref) {
      const individuals = await ctx.db
        .selectFrom('reporting_enrollments_v')
        .select(['canonical_person_id', 'confirmed_at', 'canceled_at', 'transferred_at'])
        .where('organization_id', '=', ctx.organizationId)
        .where('offering_id', '=', season.registration_offering_ref)
        .where('intent', '=', 'individual_league')
        .where('person_kind', '=', 'adult')
        .execute();
      for (const e of individuals) {
        if (heldAt(ctx.asOf, e.confirmed_at, [e.canceled_at, e.transferred_at]))
          players.add(e.canonical_person_id);
      }
    }
    return players;
  }

  private async youthOf(
    ctx: ReportContext,
    period: Period,
    programId?: string,
  ): Promise<Set<string>> {
    let q = ctx.db
      .selectFrom('reporting_enrollments_v as e')
      .innerJoin('reporting_offerings_v as o', (j) =>
        j
          .onRef('o.organization_id', '=', 'e.organization_id')
          .onRef('o.offering_id', '=', 'e.offering_id'),
      )
      .select(['e.canonical_person_id', 'e.confirmed_at', 'e.canceled_at', 'e.transferred_at'])
      .where('e.organization_id', '=', ctx.organizationId)
      .where('e.person_kind', '=', 'child')
      .where('e.intent', 'not in', ['trial', 'makeup'])
      .where('o.offering_kind', 'not in', ['trial', 'makeup'])
      .where('o.starts_on', '>=', period.from)
      .where('o.starts_on', '<=', period.to);
    if (programId) q = q.where('o.program_id', '=', programId);
    const rows = await q.execute();
    return new Set(
      rows
        .filter((r) => heldAt(ctx.asOf, r.confirmed_at, [r.canceled_at, r.transferred_at]))
        .map((r) => r.canonical_person_id),
    );
  }

  private async householdsOf(ctx: ReportContext, period: Period): Promise<Set<string>> {
    const lines = await ctx.db
      .selectFrom('reporting_order_lines_v as l')
      .innerJoin('reporting_offerings_v as o', (j) =>
        j
          .onRef('o.organization_id', '=', 'l.organization_id')
          .onRef('o.offering_id', '=', 'l.offering_id'),
      )
      .select(['l.payer_person_id', 'l.fulfilled_at', 'l.order_id', 'l.order_total_minor'])
      .where('l.organization_id', '=', ctx.organizationId)
      .where('l.fulfillment_status', '=', 'fulfilled')
      .where('o.offering_kind', '<>', 'trial')
      .where('o.starts_on', '>=', period.from)
      .where('o.starts_on', '<=', period.to)
      .execute();
    const fulfilled = lines.filter(
      (l) => l.fulfilled_at !== null && new Date(l.fulfilled_at) <= ctx.asOf,
    );
    // MET-082 excludes orders fully refunded: succeeded refunds resolved by the as-of instant reach
    // the order's total (a refund never changes an order's payment or fulfilment status).
    const orderIds = [...new Set(fulfilled.map((l) => l.order_id))];
    const refunded = new Map<string, number>();
    if (orderIds.length > 0) {
      const refunds = await ctx.db
        .selectFrom('reporting_refund_attempts_v')
        .select(['order_id', 'amount_minor'])
        .where('organization_id', '=', ctx.organizationId)
        .where('order_id', 'in', orderIds)
        .where('status', '=', 'succeeded')
        .where('resolved_at', '<=', ctx.asOf)
        .execute();
      for (const r of refunds) {
        const orderId = r.order_id as string;
        refunded.set(orderId, (refunded.get(orderId) ?? 0) + Number(r.amount_minor));
      }
    }
    const payers = [
      ...new Set(
        fulfilled
          .filter((l) => (refunded.get(l.order_id) ?? 0) < Number(l.order_total_minor))
          .map((l) => l.payer_person_id),
      ),
    ];
    if (payers.length === 0) return new Set();
    const canonical = await this.canonical(ctx, payers);
    const members = await ctx.db
      .selectFrom('reporting_household_members_v as hm')
      .innerJoin('reporting_persons_v as p', (j) =>
        j
          .onRef('p.organization_id', '=', 'hm.organization_id')
          .onRef('p.person_id', '=', 'hm.person_id'),
      )
      .select(['hm.household_id', 'p.canonical_person_id'])
      .where('hm.organization_id', '=', ctx.organizationId)
      .where('p.canonical_person_id', 'in', [...new Set(canonical.values())])
      .execute();
    return new Set(members.map((m) => m.household_id));
  }

  private async rentalPayersOf(ctx: ReportContext, period: Period): Promise<Set<string>> {
    const rows = await ctx.db
      .selectFrom('reporting_enrollments_v as e')
      .innerJoin('reporting_offerings_v as o', (j) =>
        j
          .onRef('o.organization_id', '=', 'e.organization_id')
          .onRef('o.offering_id', '=', 'e.offering_id'),
      )
      .select([
        'e.payer_person_id',
        'e.participant_person_id',
        'e.confirmed_at',
        'e.canceled_at',
        'e.transferred_at',
      ])
      .where('e.organization_id', '=', ctx.organizationId)
      .where('o.offering_kind', '=', 'rental')
      .where('o.starts_on', '>=', period.from)
      .where('o.starts_on', '<=', period.to)
      .execute();
    const payers = rows
      .filter((r) => heldAt(ctx.asOf, r.confirmed_at, [r.canceled_at, r.transferred_at]))
      .map((r) => r.payer_person_id ?? r.participant_person_id);
    if (payers.length === 0) return new Set();
    const canonical = await this.canonical(ctx, [...new Set(payers)]);
    return new Set(payers.map((p) => canonical.get(p) ?? p));
  }

  private async canonical(ctx: ReportContext, personIds: string[]): Promise<Map<string, string>> {
    const rows = await ctx.db
      .selectFrom('reporting_persons_v')
      .select(['person_id', 'canonical_person_id'])
      .where('organization_id', '=', ctx.organizationId)
      .where('person_id', 'in', personIds)
      .execute();
    return new Map(rows.map((r) => [r.person_id, r.canonical_person_id]));
  }
}
