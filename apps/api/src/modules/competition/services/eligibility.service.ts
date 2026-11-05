import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  type EligibilityEvaluation,
  type EligibilityReason,
  type EligibilitySeverity,
  type RosterPlayingStatus,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  CLOCK,
  DATABASE,
  FacilityDirectory,
  currentTransaction,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PeopleService, PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import {
  loadEntryContext,
  openRosterRows,
  peakRosterCounts,
  personSeasonMembershipRows,
  rosterRowsEffectiveAt,
  rosterRowsOverlapping,
  seasonMembershipsOf,
  statusAt,
  type EntryContext,
  type Reader,
  type RosterCounts,
  type RosterRow,
  type SeasonMembership,
} from '../competition.queries';
import {
  RESTRICTED_SOURCE_TYPES,
  ROSTER_LIMIT_STATUSES,
  ageOn,
  criteriaOf,
  isEffectiveAt,
  iso,
  referenceDateFor,
  referenceDateUsesInstant,
  referenceDateZoneNote,
} from '../competition.shared';
import {
  SUSPENSION_CHECK_PORT,
  type ActiveSuspension,
  type EligibilityPort,
  type EvaluatePlayerOptions,
  type SuspensionCheckPort,
  type SuspensionScope,
  type SuspensionSubject,
} from '../ports';

/** One player of a roster evaluation and the membership considered (default active). */
export interface RosterPlayer {
  personId: string;
  membershipStatus?: RosterPlayingStatus;
}

type PersonRow = NonNullable<Awaited<ReturnType<PeopleService['loadPerson']>>>;

/** What the rules read about one player (R4-CARRY-01), loaded by `loadFacts`. */
interface PlayerFacts {
  /** The person and everyone merged into them (CMP-08). */
  personIds: string[];
  person: PersonRow | null;
  /** The open row on this entry under the person's id, else a playing one under a merged id. */
  open: RosterRow | null;
  /** Other live entries of the season the person is on (multi-team rules). */
  others: SeasonMembership[];
  suspensions: ActiveSuspension[];
  /** On the opposing roster of `options.fixtureId`. */
  opposingRoster: boolean;
  /** The first other fixture at an overlapping time the person is committed to. */
  conflictingFixtureId: string | null;
}

/** What every player of one evaluation shares. */
interface SharedFacts {
  /** The zone an instant-based reference date is read in (R3-TIME-MONEY-03). */
  zone: string | null;
  /** The entry's busiest roster counts from `at` on; null for existing memberships. */
  counts: RosterCounts | null;
}

/** The facts of a person who does not exist in the organization. */
function missingPlayer(personId: string): PlayerFacts {
  return {
    personIds: [personId],
    person: null,
    open: null,
    others: [],
    suspensions: [],
    opposingRoster: false,
    conflictingFixtureId: null,
  };
}

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
    @Inject(PERSON_DIRECTORY_PORT) private readonly directory: PersonDirectoryPort,
    private readonly facilities: FacilityDirectory,
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
    const { membershipStatus, ...shared } = options;
    const [evaluation] = await this.evaluateRosterInContext(
      db,
      context,
      [{ personId, membershipStatus }],
      at,
      shared,
      trx,
    );
    return evaluation as EligibilityEvaluation;
  }

  /**
   * R4-CARRY-01 (§4.12, SPK-UX-006, SPK-STAFF-002): `evaluatePlayer` for every given player of one
   * entry at once, in the order given, with exactly the same rules. The entry context is read once
   * and the roster rows, season memberships, suspensions and fixture conflicts of all players in a
   * fixed number of queries, so readiness (and the staff Today feed built on it) no longer reads
   * them player by player; identity's person and merge-history reads are batched too
   * (`identityFacts`), so the number of reads does not grow with the roster.
   */
  async evaluateRoster(
    organizationId: string,
    teamEntryId: string,
    players: readonly RosterPlayer[],
    at: Date,
    options: Omit<EvaluatePlayerOptions, 'membershipStatus'> = {},
    trx?: Trx,
  ): Promise<EligibilityEvaluation[]> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const context = await loadEntryContext(db, organizationId, teamEntryId);
    if (!context) throw errors.notFound('team_entry', teamEntryId);
    return this.evaluateRosterInContext(db, context, players, at, options, trx);
  }

  /** `evaluateRoster` for callers that already hold the entry context. */
  async evaluateRosterInContext(
    db: Reader,
    context: EntryContext,
    players: readonly RosterPlayer[],
    at: Date,
    options: Omit<EvaluatePlayerOptions, 'membershipStatus'> = {},
    trx?: Trx,
  ): Promise<EligibilityEvaluation[]> {
    if (players.length === 0) return [];
    const facts = await this.loadFacts(
      db,
      context,
      [...new Set(players.map((p) => p.personId))],
      at,
      options,
      trx,
    );
    return players.map((player) => {
      const own = facts.players.get(player.personId);
      return this.decide(
        context,
        player.personId,
        at,
        { ...options, membershipStatus: player.membershipStatus },
        own ?? missingPlayer(player.personId),
        facts.shared,
      );
    });
  }

  /**
   * Every fact the rules read, for all the players in a bounded number of queries (R4-CARRY-01):
   * the entry's roster counts, the reference zone and the suspension instants are shared; the
   * open roster rows, season memberships, suspensions and fixture conflicts are read once for the
   * ids of every player and split by person in memory.
   */
  private async loadFacts(
    db: Reader,
    context: EntryContext,
    personIds: readonly string[],
    at: Date,
    options: Omit<EvaluatePlayerOptions, 'membershipStatus'>,
    trx?: Trx,
  ): Promise<{ players: Map<string, PlayerFacts>; shared: SharedFacts }> {
    const { entry, season, rules, division } = context;
    const organizationId = entry.organization_id;
    const existing = options.existingMembership ?? false;
    const identity = await this.identityFacts(db, organizationId, personIds, trx);
    // Only people who exist are evaluated further (an unknown person is refused at once).
    const found = personIds.filter((id) => identity.get(id)?.person);
    const idsOf = (personId: string): string[] => identity.get(personId)?.personIds ?? [personId];
    const allIds = [...new Set(found.flatMap(idsOf))];

    const band = division ? criteriaOf(division).ageBand : null;
    const zone =
      division &&
      band &&
      (band.minAge !== null || band.maxAge !== null) &&
      referenceDateUsesInstant(rules.eligibilityReferenceDate) &&
      found.some((id) => identity.get(id)?.person?.date_of_birth)
        ? await this.referenceZone(db, context, options)
        : null;
    // Roster limits apply to additions only; an existing membership is never re-counted.
    const counts =
      existing || found.length === 0
        ? null
        : peakRosterCounts(await rosterRowsOverlapping(db, organizationId, entry.id, at), at);

    const openRows = await openRosterRows(db, organizationId, entry.id, allIds);
    const seasonRows = await personSeasonMembershipRows(
      db,
      organizationId,
      allIds,
      season.id,
      at,
      entry.id,
      { overlapping: !existing },
    );

    // A new membership dated before now is on the current roster too, so it is also checked now.
    const scope = {
      competitionId: season.competition_id,
      seasonId: season.id,
      teamEntryId: entry.id,
    };
    const now = this.clock.now();
    const instants = !existing && at.getTime() < now.getTime() ? [at, now] : [at];
    const subjects = found.map((personId) => ({ personId, personIds: idsOf(personId) }));
    const suspensionsAt: Map<string, ActiveSuspension[]>[] = [];
    for (const instant of instants) {
      suspensionsAt.push(
        await this.suspensionsOfMany(organizationId, subjects, instant, scope, trx),
      );
    }

    const fixture = options.fixtureId
      ? await this.fixtureFacts(db, context, subjects, options.fixtureId)
      : null;

    const players = new Map<string, PlayerFacts>();
    for (const personId of personIds) {
      const person = identity.get(personId)?.person ?? null;
      if (!person) {
        players.set(personId, missingPlayer(personId));
        continue;
      }
      const ids = idsOf(personId);
      // The open row under the person's id, else a playing one under a merged id.
      let open = openRows.get(personId) ?? null;
      for (const mergedId of ids) {
        if (open !== null && statusAt(open) !== null) break;
        if (mergedId === personId) continue;
        const row = openRows.get(mergedId) ?? null;
        if (row && statusAt(row) !== null) open = row;
      }
      const own = new Set(ids);
      const suspensions: ActiveSuspension[] = [];
      for (const answer of suspensionsAt) {
        for (const suspension of answer.get(personId) ?? []) {
          if (!suspensions.some((s) => s.id === suspension.id)) suspensions.push(suspension);
        }
      }
      players.set(personId, {
        personIds: ids,
        person,
        open,
        others: seasonMembershipsOf(seasonRows.filter((row) => own.has(row.person_id))),
        suspensions,
        opposingRoster: fixture?.opposing.has(personId) ?? false,
        conflictingFixtureId: fixture?.conflicting.get(personId) ?? null,
      });
    }
    return { players, shared: { zone, counts } };
  }

  /**
   * The ids each person's records may be held under (CMP-08, SPK-IAM-007, IF-09: the person and
   * everyone merged into them) and their person row, for all players in two reads
   * (R4-CARRY-01: `PersonDirectoryPort.personIdsResolvingToMany`, `PeopleService.loadPersons`).
   */
  private async identityFacts(
    db: Reader,
    organizationId: string,
    personIds: readonly string[],
    trx?: Trx,
  ): Promise<Map<string, { personIds: string[]; person: PersonRow | null }>> {
    const out = new Map<string, { personIds: string[]; person: PersonRow | null }>();
    if (personIds.length === 0) return out;
    const resolving = await this.directory.personIdsResolvingToMany(organizationId, personIds, trx);
    const persons = await this.people.loadPersons(db, organizationId, personIds);
    for (const personId of personIds) {
      out.set(personId, {
        personIds: [...new Set([personId, ...(resolving.get(personId) ?? [])])],
        person: persons.get(personId) ?? null,
      });
    }
    return out;
  }

  /** The suspension port's batched read, or person by person when an implementation lacks it. */
  private async suspensionsOfMany(
    organizationId: string,
    subjects: SuspensionSubject[],
    at: Date,
    scope: SuspensionScope,
    trx?: Trx,
  ): Promise<Map<string, ActiveSuspension[]>> {
    if (subjects.length === 0) return new Map();
    if (this.suspensions.activeSuspensionsOfMany) {
      return this.suspensions.activeSuspensionsOfMany(organizationId, subjects, at, scope, trx);
    }
    const out = new Map<string, ActiveSuspension[]>();
    for (const { personId } of subjects) {
      out.set(
        personId,
        await this.suspensions.activeSuspensions(organizationId, personId, at, scope, trx),
      );
    }
    return out;
  }

  /**
   * The rules (SPK-CAP-004, SPK-COMP-002/003/005, SPK-AT-013), applied to one player's facts. Pure:
   * every read happened in `loadFacts`, so a single evaluation and a roster evaluation decide alike.
   */
  private decide(
    context: EntryContext,
    personId: string,
    at: Date,
    options: EvaluatePlayerOptions,
    facts: PlayerFacts,
    shared: SharedFacts,
  ): EligibilityEvaluation {
    const { entry, season, rules, division } = context;
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

    const person = facts.person;
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
        const referenceRule = rules.eligibilityReferenceDate;
        // R3-TIME-MONEY-03 (SPK-SCHED-008): an instant-based reference date is the local date at
        // the facility, not the UTC date of the instant.
        const zone = referenceDateUsesInstant(referenceRule) ? shared.zone : null;
        const reference = referenceDateFor(referenceRule, season, at, zone);
        const on = `${reference}${referenceDateZoneNote(referenceRule, zone)}`;
        const age = ageOn(person.date_of_birth, reference);
        if (band.minAge !== null && age < band.minAge) {
          add({
            code: 'below_division_age',
            severity: 'blocking',
            message: restricted
              ? `Below the division minimum age of ${band.minAge} on ${on}.`
              : `Age ${age} on ${on} is below the division minimum of ${band.minAge}.`,
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
              ? `Above the division maximum age of ${band.maxAge} on ${on}.`
              : `Age ${age} on ${on} is above the division maximum of ${band.maxAge}.`,
            source: { type: 'division', id: division.id },
            responsibleRole: 'league_manager',
            requiredAction: 'Place the player in a division whose age band applies.',
          });
        }
      }
    }

    // Existing membership on this entry (under the person's id or a merged one).
    const open = facts.open;
    const openPlaying = open !== null && statusAt(open) !== null;
    if (open !== null && openPlaying && !existing) {
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
    const counts = existing ? null : shared.counts;
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
    const others = facts.others;
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
    for (const suspension of facts.suspensions) {
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
    if (options.fixtureId && facts.opposingRoster) {
      add({
        code: 'opposing_roster',
        severity: 'blocking',
        message: 'The person is on the opposing roster for this fixture.',
        source: { type: 'fixture', id: options.fixtureId },
        responsibleRole: 'league_manager',
        requiredAction: 'A player cannot appear for both sides of a fixture.',
      });
    }
    if (options.fixtureId && facts.conflictingFixtureId) {
      add({
        code: 'conflicting_fixture',
        severity: 'blocking',
        message: 'The person is committed to another fixture at an overlapping time.',
        source: { type: 'fixture', id: facts.conflictingFixtureId },
        responsibleRole: 'league_manager',
        requiredAction: 'Resolve the overlapping participation first.',
      });
    }

    return this.result(context, personId, at, membershipStatus, reasons);
  }

  /**
   * R3-TIME-MONEY-03 (SPK-SCHED-008): the IANA zone an instant-based reference date is read in.
   * The caller's zone when given; otherwise, for a fixture, the venue's facility (copied from its
   * scheduling event); otherwise the division's facility. Null only when none is known.
   */
  private async referenceZone(
    db: Reader,
    context: EntryContext,
    options: EvaluatePlayerOptions,
  ): Promise<string | null> {
    if (options.timezone) return options.timezone;
    const organizationId = context.entry.organization_id;
    let facilityId: string | null = null;
    if (options.fixtureId) {
      const fixture = await db
        .selectFrom('fixtures')
        .select('venue_facility_id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', options.fixtureId)
        .executeTakeFirst();
      facilityId = fixture?.venue_facility_id ?? null;
    }
    facilityId ??= context.division?.facility_id ?? null;
    if (!facilityId) return null;
    const facility = (await this.facilities.describe(organizationId, [facilityId], db)).get(
      facilityId,
    );
    return facility?.timezone ?? null;
  }

  /**
   * Conflicting participation for one fixture (SPK-CAP-004), for every subject in three queries:
   * who is on the opposing roster at the fixture's time, and for each person the first other
   * scheduled fixture at an overlapping time they are committed to (under any of their ids).
   */
  private async fixtureFacts(
    db: Reader,
    context: EntryContext,
    subjects: readonly SuspensionSubject[],
    fixtureId: string,
  ): Promise<{ opposing: Set<string>; conflicting: Map<string, string> }> {
    const opposingPeople = new Set<string>();
    const conflicting = new Map<string, string>();
    if (subjects.length === 0) return { opposing: opposingPeople, conflicting };
    const organizationId = context.entry.organization_id;
    const fixture = await db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', fixtureId)
      .executeTakeFirst();
    if (!fixture) return { opposing: opposingPeople, conflicting };
    const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : this.clock.now();
    const allIds = [...new Set(subjects.flatMap((s) => s.personIds))];
    const opposing =
      fixture.home_entry_id === context.entry.id ? fixture.away_entry_id : fixture.home_entry_id;
    if (opposing) {
      const rows = await rosterRowsEffectiveAt(db, organizationId, opposing, at);
      for (const subject of subjects) {
        if (rows.some((r) => subject.personIds.includes(r.person_id) && statusAt(r) !== null)) {
          opposingPeople.add(subject.personId);
        }
      }
    }
    if (fixture.scheduled_start && fixture.scheduled_end && allIds.length > 0) {
      const rows = await db
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
          'rm.person_id',
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
        .where('rm.person_id', 'in', allIds)
        .where('rm.status', 'in', ['active', 'guest', 'substitute', 'removed'])
        .orderBy('f.scheduled_start')
        .orderBy('f.id')
        .orderBy('rm.id')
        .execute();
      for (const subject of subjects) {
        const first = rows.find(
          (row) => subject.personIds.includes(row.person_id) && isEffectiveAt(row, at),
        );
        if (first) conflicting.set(subject.personId, first.id);
      }
    }
    return { opposing: opposingPeople, conflicting };
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
