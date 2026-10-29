import {
  AvailabilityStateSchema,
  defineEvent,
  FixtureStatusSchema,
  RosterPlayingStatusSchema,
  SeasonStatusSchema,
  TeamEntryStatusSchema,
  TeamRoleSchema,
  z,
} from '@sportspark/contracts';

/**
 * Competition domain events, part 1 (§4.12). Payloads carry identifiers only: no names, dates of
 * birth or contact details (§4.14); consumers read through the module's ports when authorized.
 */
export const CompetitionEvents = {
  competitionCreated: defineEvent(
    'competition.competition_created',
    z.object({ competitionId: z.uuid(), kind: z.string(), sportFormat: z.string() }),
  ),
  competitionUpdated: defineEvent(
    'competition.competition_updated',
    z.object({ competitionId: z.uuid(), status: z.string(), revision: z.number().int() }),
  ),
  ruleSetCreated: defineEvent(
    'competition.rule_set_created',
    z.object({
      ruleSetId: z.uuid(),
      name: z.string(),
      format: z.string(),
      version: z.number().int(),
      supersedesRuleSetId: z.uuid().nullable(),
    }),
  ),
  seasonCreated: defineEvent(
    'competition.season_created',
    z.object({ seasonId: z.uuid(), competitionId: z.uuid(), ruleSetId: z.uuid() }),
  ),
  seasonUpdated: defineEvent(
    'competition.season_updated',
    z.object({
      seasonId: z.uuid(),
      competitionId: z.uuid(),
      status: SeasonStatusSchema,
      previousStatus: SeasonStatusSchema,
      revision: z.number().int(),
    }),
  ),
  divisionCreated: defineEvent(
    'competition.division_created',
    z.object({ divisionId: z.uuid(), seasonId: z.uuid() }),
  ),
  divisionUpdated: defineEvent(
    'competition.division_updated',
    z.object({ divisionId: z.uuid(), seasonId: z.uuid(), revision: z.number().int() }),
  ),
  teamCreated: defineEvent(
    'competition.team_created',
    z.object({ teamId: z.uuid(), createdByPersonId: z.uuid().nullable() }),
  ),
  teamUpdated: defineEvent(
    'competition.team_updated',
    z.object({ teamId: z.uuid(), status: z.string(), revision: z.number().int() }),
  ),
  /** Enrollment/finance react to a new entry (registration obligations); nothing is charged here (SPK-CAP-005). */
  teamEntryCreated: defineEvent(
    'competition.team_entry_created',
    z.object({
      teamEntryId: z.uuid(),
      seasonId: z.uuid(),
      teamId: z.uuid(),
      captainPersonId: z.uuid(),
      renewedFromEntryId: z.uuid().nullable(),
      registrationOfferingRef: z.string().nullable(),
      operationId: z.uuid(),
    }),
  ),
  teamEntryStatusChanged: defineEvent(
    'competition.team_entry_status_changed',
    z.object({
      teamEntryId: z.uuid(),
      seasonId: z.uuid(),
      teamId: z.uuid(),
      status: TeamEntryStatusSchema,
      previousStatus: TeamEntryStatusSchema,
      divisionId: z.uuid().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  teamRoleChanged: defineEvent(
    'competition.team_role_changed',
    z.object({
      teamEntryId: z.uuid(),
      personId: z.uuid(),
      role: TeamRoleSchema,
      change: z.enum(['assigned', 'ended']),
    }),
  ),
  /** One per roster row opened or closed (SPK-COMP-005). */
  rosterChanged: defineEvent(
    'competition.roster_changed',
    z.object({
      teamEntryId: z.uuid(),
      seasonId: z.uuid(),
      personId: z.uuid(),
      membershipId: z.uuid(),
      change: z.enum(['added', 'removed']),
      status: RosterPlayingStatusSchema,
      effectiveFrom: z.iso.datetime(),
      effectiveTo: z.iso.datetime().nullable(),
      source: z.string(),
    }),
  ),
  /** Communications delivers the invitation (recipient resolved by id or contact, never in the payload). */
  teamInvitationCreated: defineEvent(
    'competition.team_invitation_created',
    z.object({
      invitationId: z.uuid(),
      teamEntryId: z.uuid(),
      recipientPersonId: z.uuid().nullable(),
      recipientContactKind: z.string().nullable(),
      expiresAt: z.iso.datetime(),
    }),
  ),
  teamInvitationResolved: defineEvent(
    'competition.team_invitation_resolved',
    z.object({
      invitationId: z.uuid(),
      teamEntryId: z.uuid(),
      status: z.enum(['accepted', 'declined', 'revoked', 'expired']),
      personId: z.uuid().nullable(),
    }),
  ),
  joinRequestCreated: defineEvent(
    'competition.join_request_created',
    z.object({ requestId: z.uuid(), teamEntryId: z.uuid(), personId: z.uuid() }),
  ),
  joinRequestDecided: defineEvent(
    'competition.join_request_decided',
    z.object({
      requestId: z.uuid(),
      teamEntryId: z.uuid(),
      personId: z.uuid(),
      decision: z.enum(['approved', 'declined', 'withdrawn']),
    }),
  ),
  fixtureCreated: defineEvent(
    'competition.fixture_created',
    z.object({
      fixtureId: z.uuid(),
      seasonId: z.uuid(),
      divisionId: z.uuid().nullable(),
      homeEntryId: z.uuid(),
      awayEntryId: z.uuid().nullable(),
      operationId: z.uuid(),
    }),
  ),
  /** Status or time change of a fixture; readiness (part 2) and communications re-evaluate. */
  fixtureChanged: defineEvent(
    'competition.fixture_changed',
    z.object({
      fixtureId: z.uuid(),
      seasonId: z.uuid(),
      homeEntryId: z.uuid(),
      awayEntryId: z.uuid().nullable(),
      status: FixtureStatusSchema,
      previousStatus: FixtureStatusSchema,
      schedulingEventId: z.uuid().nullable(),
      scheduledStart: z.iso.datetime().nullable(),
      scheduledEnd: z.iso.datetime().nullable(),
      change: z.enum([
        'scheduled',
        'rescheduled',
        'postponed',
        'unscheduled',
        'canceled',
        'edited',
        'outcome_recorded',
        'synced_from_scheduling',
      ]),
      reason: z.string().nullable(),
    }),
  ),
  /**
   * CMP-14, IF-45 (SPK-CAP-001): a captain or league staff asked the entry's players without an
   * answer for their availability; each request id is one notice per recipient (communications).
   */
  availabilityRequested: defineEvent(
    'competition.availability_requested',
    z.object({
      requestId: z.uuid(),
      fixtureId: z.uuid(),
      teamEntryId: z.uuid(),
      recipientPersonIds: z.array(z.uuid()),
      scheduledStart: z.string(),
      facilityId: z.uuid().nullable(),
    }),
  ),
  /** RSVP recorded. RSVP is neither attendance nor eligibility (SPK-CAP-003). */
  availabilityResponded: defineEvent(
    'competition.availability_responded',
    z.object({
      fixtureId: z.uuid(),
      teamEntryId: z.uuid(),
      personId: z.uuid(),
      state: AvailabilityStateSchema,
    }),
  ),
} as const;
