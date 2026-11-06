import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import { ActorSnapshotSchema } from './facilities';

/**
 * Competition API contract, placement and field-side work (migrations 0464 to 0466):
 *
 * - staff player profiles for the placement board: position (goalkeeper or an outfield line) and
 *   a staff skill rating, with each team's keeper count and skill average (SPK-PLACE-002,
 *   SPK-PLACE-005: staff-only, never public; the 1 to 5 scale is an engineering placeholder);
 * - fixture attendance: player check-in on the match sheet (SPK-UX-007, SPK-STAFF-005;
 *   SPK-CAP-003 RSVP is neither attendance nor eligibility);
 * - fixtures waiting for a result after the game, with a forfeit the rule set and the recorded
 *   attendance suggest, and reminders to the captains (SPK-RESULT-001, SPK-RESULT-002,
 *   SPK-UX-006).
 */

// ---------------------------------------------------------------------------------------------
// Player profiles (SPK-PLACE-002)
// ---------------------------------------------------------------------------------------------
export const PlayerPositionSchema = z
  .enum(['goalkeeper', 'defender', 'midfielder', 'forward', 'outfield'])
  .openapi('PlayerPosition');
export type PlayerPosition = z.infer<typeof PlayerPositionSchema>;

/** Engineering placeholder scale (competition.policy.ts `SKILL_RATING_SCALE`). */
export const SkillRating = z.number().int().min(1).max(5);

export const PlayerProfileSchema = z
  .object({
    id: z.uuid(),
    seasonId: z.uuid(),
    personId: z.uuid(),
    position: PlayerPositionSchema.nullable(),
    skillRating: SkillRating.nullable(),
    note: z.string().nullable(),
    recordedBy: ActorSnapshotSchema,
    recordedAt: Instant,
    revision: Revision,
  })
  .openapi('PlayerProfile');
export type PlayerProfile = z.infer<typeof PlayerProfileSchema>;

/** One team of the season as the board balances it: its playing roster now, keepers, skill. */
export const TeamBalanceSchema = z
  .object({
    teamEntryId: z.uuid(),
    /** Active, guest and substitute players on the roster now. */
    players: z.number().int(),
    /** Players whose profile names them goalkeeper. */
    goalkeepers: z.number().int(),
    /** Players with a skill rating. */
    rated: z.number().int(),
    /** Mean skill rating of the rated players, one decimal; null when nobody is rated. */
    averageSkill: z.number().nullable(),
  })
  .openapi('TeamBalance');
export type TeamBalance = z.infer<typeof TeamBalanceSchema>;

export const SeasonPlayerProfilesSchema = z
  .object({
    seasonId: z.uuid(),
    evaluatedAt: Instant,
    /** The scale ratings use (engineering placeholder, pending the operator's placement model). */
    skillScale: z.object({ min: z.number().int(), max: z.number().int() }),
    profiles: z.array(PlayerProfileSchema),
    /** Approved and applied entries of the season (withdrawn and rejected ones are left out). */
    teams: z.array(TeamBalanceSchema),
  })
  .openapi('SeasonPlayerProfiles');
export type SeasonPlayerProfiles = z.infer<typeof SeasonPlayerProfilesSchema>;

/** `?personIds=a,b` or repeated `personIds`. */
const commaList = (value: unknown) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : value;

export const ListPlayerProfilesQuery = z.object({
  /** Person ids to narrow the profiles to (teams are always listed). */
  personIds: z.preprocess(commaList, z.array(z.uuid()).min(1).max(200)).optional(),
});
export type ListPlayerProfilesQuery = z.infer<typeof ListPlayerProfilesQuery>;

/**
 * `POST /v1/seasons/{id}/player-profiles`: record or change a person's staff profile for the
 * season. Changing an existing profile names its revision (STALE_REVISION otherwise, §4.9).
 */
export const RecordPlayerProfileBody = withCommandMeta({
  personId: z.uuid(),
  position: PlayerPositionSchema.nullable(),
  skillRating: SkillRating.nullable(),
  note: z.string().trim().min(1).max(500).nullable().optional(),
})
  .refine((b) => b.position !== null || b.skillRating !== null, {
    message: 'Give a position, a skill rating, or both.',
    path: ['position'],
  })
  .openapi('RecordPlayerProfileRequest');
export type RecordPlayerProfileInput = z.infer<typeof RecordPlayerProfileBody>;

// ---------------------------------------------------------------------------------------------
// Fixture attendance (SPK-UX-007, SPK-STAFF-005)
// ---------------------------------------------------------------------------------------------
/** `cleared` withdraws an earlier mark: the player is unmarked again. */
export const AttendanceMarkStateSchema = z
  .enum(['present', 'absent', 'cleared'])
  .openapi('AttendanceMarkState');
export type AttendanceMarkState = z.infer<typeof AttendanceMarkStateSchema>;

export const RecordFixtureAttendanceBody = withCommandMeta({
  teamEntryId: z.uuid(),
  personId: z.uuid(),
  state: AttendanceMarkStateSchema,
}).openapi('RecordFixtureAttendanceRequest');
export type RecordFixtureAttendanceInput = z.infer<typeof RecordFixtureAttendanceBody>;

export const FixtureAttendanceMarkSchema = z
  .object({
    id: z.uuid(),
    fixtureId: z.uuid(),
    teamEntryId: z.uuid(),
    personId: z.uuid(),
    state: AttendanceMarkStateSchema,
    recordedBy: ActorSnapshotSchema,
    recordedAt: Instant,
  })
  .openapi('FixtureAttendanceMark');
export type FixtureAttendanceMark = z.infer<typeof FixtureAttendanceMarkSchema>;

export const FixtureAttendanceSchema = z
  .object({
    fixtureId: z.uuid(),
    sides: z.array(
      z.object({
        teamEntryId: z.uuid(),
        present: z.number().int(),
        absent: z.number().int(),
        /** Each player's latest mark; a cleared mark is left out. */
        marks: z.array(FixtureAttendanceMarkSchema),
      }),
    ),
  })
  .openapi('FixtureAttendance');
export type FixtureAttendance = z.infer<typeof FixtureAttendanceSchema>;

// ---------------------------------------------------------------------------------------------
// Results awaiting a decision, and reminders to captains (SPK-RESULT-001/002, SPK-UX-006)
// ---------------------------------------------------------------------------------------------
/** At most this many fixtures are listed by one read (the oldest first). */
export const RESULTS_AWAITING_MAX = 100;

export const ResultAwaitingSchema = z
  .object({
    fixtureId: z.uuid(),
    scheduledStart: Instant,
    scheduledEnd: Instant,
    divisionId: z.uuid().nullable(),
    sides: z.array(
      z.object({
        teamEntryId: z.uuid(),
        teamName: z.string(),
        /** Players marked present; null when nobody of the side was marked at all. */
        present: z.number().int().nullable(),
      }),
    ),
    /** The rule set's `forfeit.minimumPlayersToStart`. */
    minimumPlayersToStart: z.number().int(),
    /**
     * A forfeit the recorded attendance and the rule set suggest: exactly one side was marked
     * below the minimum while the other reached it. A suggestion only: recording it is the
     * ordinary result submission and publication.
     */
    suggestedForfeit: z
      .object({
        forfeitingEntryId: z.uuid(),
        homeScore: z.number().int(),
        awayScore: z.number().int(),
        reason: z.string(),
      })
      .nullable(),
    reminderCount: z.number().int(),
    lastReminderAt: Instant.nullable(),
  })
  .openapi('ResultAwaiting');
export type ResultAwaiting = z.infer<typeof ResultAwaitingSchema>;

export const ResultsAwaitingSchema = z
  .object({
    seasonId: z.uuid(),
    evaluatedAt: Instant,
    items: z.array(ResultAwaitingSchema),
    /** True when more than RESULTS_AWAITING_MAX fixtures wait (the oldest are listed). */
    truncated: z.boolean(),
  })
  .openapi('ResultsAwaiting');
export type ResultsAwaiting = z.infer<typeof ResultsAwaitingSchema>;

export const CreateResultReminderBody = withCommandMeta({
  message: z.string().trim().min(1).max(500).optional(),
}).openapi('CreateResultReminderRequest');
export type CreateResultReminderInput = z.infer<typeof CreateResultReminderBody>;

export const ResultReminderSchema = z
  .object({
    id: z.uuid(),
    fixtureId: z.uuid(),
    requestedBy: ActorSnapshotSchema,
    message: z.string().nullable(),
    requestedAt: Instant,
    /** Captains (and co-captains) of both sides at the time of the reminder. */
    recipientCount: z.number().int(),
  })
  .openapi('ResultReminder');
export type ResultReminder = z.infer<typeof ResultReminderSchema>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const IdParams = z.object({ id: z.uuid() });
const TAG = 'Competition';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });

function command(path: string, summary: string, body: z.ZodType, response: z.ZodType) {
  openApiRegistry.registerPath({
    method: 'post',
    path,
    summary,
    tags: [TAG],
    request: {
      params: IdParams,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: body } } },
    },
    responses: {
      201: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)'),
    },
  });
}

function query(
  path: string,
  summary: string,
  request: z.ZodObject<z.ZodRawShape> | null,
  response: z.ZodType,
) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    request: { params: IdParams, query: request ?? undefined },
    responses: {
      200: ok('Result', response),
      403: err('Access denied'),
      404: err('Not found or not visible'),
    },
  });
}

query(
  '/seasons/{id}/player-profiles',
  'Staff player profiles of a season with each team’s keepers and skill balance (SPK-PLACE-002)',
  ListPlayerProfilesQuery,
  SeasonPlayerProfilesSchema,
);
command(
  '/seasons/{id}/player-profiles',
  'Record or change a player’s staff profile for the season (SPK-PLACE-002)',
  RecordPlayerProfileBody,
  PlayerProfileSchema,
);
query(
  '/fixtures/{id}/attendance',
  'Player check-in of a fixture: each player’s latest mark (SPK-UX-007)',
  null,
  FixtureAttendanceSchema,
);
command(
  '/fixtures/{id}/attendance',
  'Mark a rostered player present or absent at the field, or clear the mark (SPK-UX-007, SPK-STAFF-005)',
  RecordFixtureAttendanceBody,
  FixtureAttendanceMarkSchema,
);
query(
  '/seasons/{id}/results-awaiting',
  'Fixtures played without a result, with suggested forfeits and reminders (SPK-RESULT-001, SPK-UX-006)',
  null,
  ResultsAwaitingSchema,
);
command(
  '/fixtures/{id}/result-reminders',
  'Remind the captains of both sides that the fixture’s result is missing (SPK-RESULT-001)',
  CreateResultReminderBody,
  ResultReminderSchema,
);
