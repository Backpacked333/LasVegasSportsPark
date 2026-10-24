import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type EligibilityEvaluation,
  type EligibilityReason,
  type EligibilitySeverity,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { CLOCK, DATABASE, currentTransaction, type Clock, type Trx } from '../../../kernel';
import { PeopleService } from '../../identity';
import {
  loadEntryContext,
  openRosterRow,
  peakRosterCounts,
  personSeasonMemberships,
  rosterRowsEffectiveAt,
  rosterRowsOverlapping,
  statusAt,
  type EntryContext,
  type Reader,
} from '../competition.queries';
import {
  RESTRICTED_SOURCE_TYPES,
  ROSTER_LIMIT_STATUSES,
  ageOn,
  criteriaOf,
  isEffectiveAt,
  iso,
  referenceDateFor,
} from '../competition.shared';
import {
  SUSPENSION_CHECK_PORT,
  type ActiveSuspension,
  type EligibilityPort,
  type EvaluatePlayerOptions,
  type SuspensionCheckPort,
} from '../ports';

interface ReasonInput {
  code: string;
  severity: EligibilitySeverity;
  message: string;
  source: { type: string; id: string | null };
  responsibleRole: string;
  requiredAction: string;
}

/**
 * ELIGIBILITY_PORT (SPK-CAP-004, SPK-COMP-005, SPK-AT-013). Every rule is evaluated against the
 * season's rule-set version and the division's documented criteria, with an explainable reason
 * that names the source record, the responsible role and the required action (SPK-READY-003).
 * Age is computed from the identity module's date of birth at the rule set's reference date,
 * never from a stored age (§4.5). The membership being considered (active, guest, substitute)
 * changes the limits that apply, never whether the rules apply: a guest label bypasses nothing.
 */
@Injectable()
export class EligibilityService implements EligibilityPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SUSPENSION_CHECK_PORT) private readonly suspensions: SuspensionCheckPort,
    private readonly people: PeopleService,
  ) {}

  async evaluatePlayer(
    organizationId: string,
    teamEntryId: string,
    personId: string,
    at: Date,
    options: EvaluatePlayerOptions = {},
    trx?: Trx,
  ): Promise<EligibilityEvaluation> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const context = await loadEntryContext(db, organizationId, teamEntryId);
    if (!context) throw errors.notFound('team_entry', teamEntryId);
    return this.evaluateInContext(db, context, personId, at, options, trx);
  }

  /** Same evaluation for callers that already hold the entry context (roster listings). */
  async evaluateInContext(
    db: Reader,
    context: EntryContext,
    personId: string,
    at: Date,
    options: EvaluatePlayerOptions = {},
    trx?: Trx,
  ): Promise<EligibilityEvaluation> {
    const { entry, season, rules, division } = context;
    const organizationId = entry.organization_id;
    const membershipStatus = options.membershipStatus ?? 'active';
    const existing = options.existingMembership ?? false;
    const reasons: EligibilityReason[] = [];
    const restricted = options.restricted ?? false;
    // SPK-CAP-002 / SPK-DISC-004: a caller who is not staff never learns restricted record ids.
    const add = (r: ReasonInput) =>
      reasons.push(
        restricted && RESTRICTED_SOURCE_TYPES.has(r.source.type)
          ? { ...r, source: { type: r.source.type, id: null } }
          : r,
      );

    const person = await this.people.loadPerson(db, organizationId, personId);
    if (!person) {
      add({
        code: 'person_not_found',
        severity: 'blocking',
        message: 'The person does not exist in this organization.',
        source: { type: 'person', id: personId },
        responsibleRole: 'front_desk',
        requiredAction: 'Create or claim the person record first.',
      });
      return this.result(context, personId, at, membershipStatus, reasons);
    }
    if (person.status !== 'active') {
      add({
        code: 'person_inactive',
        severity: 'blocking',
        message: `The person record is ${person.status}.`,
        source: { type: 'person', id: personId },
        responsibleRole: 'front_desk',
        requiredAction: 'Reactivate the person record or use the surviving record.',
      });
    }

    // Entry and season state (SPK-COMP-004: approval is distinct, but a closed entry takes no players).
    if (entry.status !== 'applied' && entry.status !== 'approved') {
      add({
        code: 'entry_not_active',
        severity: 'blocking',
        message: `The team entry is ${entry.status}.`,
        source: { type: 'team_entry', id: entry.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Create a new entry for the season.',
      });
    } else if (entry.status === 'applied') {
      add({
        code: 'entry_pending_approval',
        severity: 'info',
        message: 'The team entry has not been approved yet.',
        source: { type: 'team_entry', id: entry.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Approve the entry.',
      });
    }
    if (season.status === 'completed' || season.status === 'archived') {
      add({
        code: 'season_closed',
        severity: 'blocking',
        message: `The season is ${season.status}.`,
        source: { type: 'season', id: season.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Roster changes are closed for this season.',
      });
    }

    // Division age band at the rule set's reference date (SPK-COMP-003, §4.5).
    const band = division ? criteriaOf(division).ageBand : null;
    if (division && band && (band.minAge !== null || band.maxAge !== null)) {
      if (!person.date_of_birth) {
        add({
          code: 'date_of_birth_unknown',
          severity: 'unknown',
          message: 'The division has an age band but the person has no date of birth on record.',
          source: { type: 'person', id: personId },
          responsibleRole: 'front_desk',
          requiredAction: 'Record the date of birth.',
        });
      } else {
        const reference = referenceDateFor(rules.eligibilityReferenceDate, season, at);
        const age = ageOn(person.date_of_birth, reference);
        if (band.minAge !== null && age < band.minAge) {
          add({
            code: 'below_division_age',
            severity: 'blocking',
            message: restricted
              ? `Below the division minimum age of ${band.minAge} on ${reference}.`
              : `Age ${age} on ${reference} is below the division minimum of ${band.minAge}.`,
            source: { type: 'division', id: division.id },
            responsibleRole: 'league_manager',
            requiredAction: 'Place the player in a division whose age band applies.',
          });
        }
        if (band.maxAge !== null && age > band.maxAge) {
          add({
            code: 'above_division_age',
            severity: 'blocking',
            message: restricted
              ? `Above the division maximum age of ${band.maxAge} on ${reference}.`
              : `Age ${age} on ${reference} is above the division maximum of ${band.maxAge}.`,
            source: { type: 'division', id: division.id },
            responsibleRole: 'league_manager',
            requiredAction: 'Place the player in a division whose age band applies.',
          });
        }
      }
    }

    // Existing membership on this entry.
    const open = await openRosterRow(db, organizationId, entry.id, personId);
    const openPlaying = open !== null && statusAt(open) !== null;
    if (openPlaying && !existing) {
      add({
        code: 'already_on_roster',
        severity: 'blocking',
        message: 'The person already holds an open roster membership on this entry.',
        source: { type: 'roster_membership', id: open.id },
        responsibleRole: 'captain',
        requiredAction: 'Remove the current membership before adding a different one.',
      });
    }

    // Roster limits from the rule set (SPK-COMP-002 "Roster limits"). A new membership holds its
    // place from `at` onwards (its row is open-ended), so it is checked against the busiest instant
    // of that interval: rows starting later (future-dated additions) count as well (SPK-COMP-005).
    // The limits apply to additions only; an existing membership is never re-counted against them.
    const counts = existing
      ? null
      : peakRosterCounts(await rosterRowsOverlapping(db, organizationId, entry.id, at), at);
    if (
      counts &&
      ROSTER_LIMIT_STATUSES.includes(membershipStatus) &&
      counts.limited >= rules.rosterMax
    ) {
      add({
        code: 'roster_full',
        severity: 'blocking',
        message: `The roster already has ${counts.limited} of ${rules.rosterMax} players.`,
        source: { type: 'rule_set', id: context.ruleSet.id },
        responsibleRole: 'captain',
        requiredAction: 'Remove a player or ask the league manager about the roster limit.',
      });
    }
    if (membershipStatus === 'guest') {
      if (!rules.roster.guestPlayersAllowed) {
        add({
          code: 'guests_not_allowed',
          severity: 'blocking',
          message: 'The rule set does not allow guest players.',
          source: { type: 'rule_set', id: context.ruleSet.id },
          responsibleRole: 'league_manager',
          requiredAction: 'Add the player as a regular roster member if eligible.',
        });
      } else if (
        counts &&
        rules.roster.guestMaxConcurrent !== null &&
        counts.guests >= rules.roster.guestMaxConcurrent
      ) {
        add({
          code: 'guest_limit_reached',
          severity: 'blocking',
          message: `The roster already has ${counts.guests} of ${rules.roster.guestMaxConcurrent} guests.`,
          source: { type: 'rule_set', id: context.ruleSet.id },
          responsibleRole: 'captain',
          requiredAction: 'Remove a guest before adding another.',
        });
      }
    }
    if (membershipStatus === 'substitute' && !rules.roster.substitutesAllowed) {
      add({
        code: 'substitutes_not_allowed',
        severity: 'blocking',
        message: 'The rule set does not allow substitute memberships.',
        source: { type: 'rule_set', id: context.ruleSet.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Add the player as a regular roster member if eligible.',
      });
    }
    if (
      (membershipStatus === 'guest' || membershipStatus === 'substitute') &&
      rules.roster.guestOrSubstituteRequiresApproval &&
      !options.actorIsStaff &&
      !existing
    ) {
      add({
        code: 'approval_required',
        severity: 'blocking',
        message: 'Guest and substitute additions require league approval under this rule set.',
        source: { type: 'rule_set', id: context.ruleSet.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Ask the league manager to add the player.',
      });
    }

    // Multi-team restrictions within the season (SPK-COMP-005 "respect competition restrictions").
    // An addition counts every other membership effective at any instant from `at` on, so neither a
    // later membership elsewhere nor a backdated addition slips past the limits.
    const others = await personSeasonMemberships(
      db,
      organizationId,
      personId,
      season.id,
      at,
      entry.id,
      { overlapping: !existing },
    );
    const limit = rules.multiTeamRestrictions.maxEntriesPerSeason;
    if (limit !== null && others.length + 1 > limit) {
      add({
        code: 'multi_team_limit',
        severity: 'blocking',
        message: restricted
          ? `The person has reached the season limit of ${limit} team(s).`
          : `The person is already on ${others.length} other team(s) this season; the limit is ${limit}.`,
        source: { type: 'rule_set', id: context.ruleSet.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Remove the player from another team or approve an exception.',
      });
    }
    if (
      !rules.multiTeamRestrictions.allowSameDivision &&
      entry.division_id !== null &&
      others.some((o) => o.divisionId === entry.division_id)
    ) {
      add({
        code: 'already_in_division',
        severity: 'blocking',
        message: 'The person already plays for another team in this division.',
        source: { type: 'division', id: entry.division_id },
        responsibleRole: 'league_manager',
        requiredAction: 'Transfer the player instead of adding a second membership.',
      });
    }
    if (
      !rules.multiTeamRestrictions.allowCrossDivision &&
      others.some((o) => o.divisionId !== entry.division_id)
    ) {
      add({
        code: 'cross_division_not_allowed',
        severity: 'blocking',
        message: 'The rule set does not allow playing in more than one division this season.',
        source: { type: 'rule_set', id: context.ruleSet.id },
        responsibleRole: 'league_manager',
        requiredAction: 'Remove the player from the other division first.',
      });
    }

    // Suspension status (SPK-CAP-004, SPK-AT-013): the discipline port is authoritative. A new
    // membership dated before now is on the current roster too, so it is also checked now: a
    // backdated addition never places a currently suspended player on the roster.
    const scope = {
      competitionId: season.competition_id,
      seasonId: season.id,
      teamEntryId: entry.id,
    };
    const now = this.clock.now();
    const instants = !existing && at.getTime() < now.getTime() ? [at, now] : [at];
    const suspensions: ActiveSuspension[] = [];
    for (const instant of instants) {
      for (const suspension of await this.suspensions.activeSuspensions(
        organizationId,
        personId,
        instant,
        scope,
        trx,
      )) {
        if (!suspensions.some((s) => s.id === suspension.id)) suspensions.push(suspension);
      }
    }
    for (const suspension of suspensions) {
      add({
        code: 'suspended',
        severity: 'blocking',
        // Never the suspension's basis text (staff free text): staff read the suspension by id.
        message: `The person has an active suspension in scope${suspension.until ? ` until ${suspension.until}` : ''}.`,
        source: { type: 'suspension', id: suspension.id },
        responsibleRole: 'league_manager',
        requiredAction: 'The suspension must end or be lifted before the player can be added.',
      });
    }

    // Conflicting participation for a specific fixture (SPK-CAP-004).
    if (options.fixtureId) {
      await this.fixtureConflicts(db, context, personId, options.fixtureId, add);
    }

    return this.result(context, personId, at, membershipStatus, reasons);
  }

  private async fixtureConflicts(
    db: Reader,
    context: EntryContext,
    personId: string,
    fixtureId: string,
    add: (r: ReasonInput) => void,
  ): Promise<void> {
    const organizationId = context.entry.organization_id;
    const fixture = await db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', fixtureId)
      .executeTakeFirst();
    if (!fixture) return;
    const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : this.clock.now();
    const opposing =
      fixture.home_entry_id === context.entry.id ? fixture.away_entry_id : fixture.home_entry_id;
    if (opposing) {
      const rows = await rosterRowsEffectiveAt(db, organizationId, opposing, at);
      if (rows.some((r) => r.person_id === personId && statusAt(r) !== null)) {
        add({
          code: 'opposing_roster',
          severity: 'blocking',
          message: 'The person is on the opposing roster for this fixture.',
          source: { type: 'fixture', id: fixture.id },
          responsibleRole: 'league_manager',
          requiredAction: 'A player cannot appear for both sides of a fixture.',
        });
      }
    }
    if (fixture.scheduled_start && fixture.scheduled_end) {
      const conflicts = await db
        .selectFrom('fixtures as f')
        .innerJoin('roster_memberships as rm', (join) =>
          join
            .onRef('rm.organization_id', '=', 'f.organization_id')
            .on((eb) =>
              eb.or([
                eb('rm.team_entry_id', '=', eb.ref('f.home_entry_id')),
                eb('rm.team_entry_id', '=', eb.ref('f.away_entry_id')),
              ]),
            ),
        )
        .select([
          'f.id',
          'rm.effective_from',
          'rm.effective_to',
          'rm.status',
          'rm.status_before_removal',
        ])
        .where('f.organization_id', '=', organizationId)
        .where('f.id', '<>', fixture.id)
        .where('f.status', '=', 'scheduled')
        .where('f.scheduled_start', '<', fixture.scheduled_end)
        .where('f.scheduled_end', '>', fixture.scheduled_start)
        .where('rm.person_id', '=', personId)
        .where('rm.status', 'in', ['active', 'guest', 'substitute', 'removed'])
        .execute();
      for (const row of conflicts) {
        if (!isEffectiveAt(row, at)) continue;
        add({
          code: 'conflicting_fixture',
          severity: 'blocking',
          message: 'The person is committed to another fixture at an overlapping time.',
          source: { type: 'fixture', id: row.id },
          responsibleRole: 'league_manager',
          requiredAction: 'Resolve the overlapping participation first.',
        });
        break;
      }
    }
  }

  private result(
    context: EntryContext,
    personId: string,
    at: Date,
    membershipStatus: EligibilityEvaluation['membershipStatus'],
    reasons: EligibilityReason[],
  ): EligibilityEvaluation {
    return {
      teamEntryId: context.entry.id,
      personId,
      at: iso(at),
      membershipStatus,
      // Unknown evidence is not a pass (SPK-READY-002): only warnings and information leave the player eligible.
      eligible: reasons.every((r) => r.severity === 'warning' || r.severity === 'info'),
      reasons,
      evaluatedAt: iso(this.clock.now()),
    };
  }
}
