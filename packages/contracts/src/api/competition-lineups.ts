import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import { AvailabilityStateSchema, FixtureStatusSchema } from './competition';

/**
 * Competition API contract, the coach's team sheet (migration 0475; SPK-CAP-001 captain tools,
 * SPK-CAP-003 availability, SPK-UX-007 field-side work, SPK-RESULT-001; staff redesign Phase 8
 * "Coach · Lineup" and "Coach · Live game day"):
 *
 * - the side's players with their availability answer and their minutes this season, the
 *   lineup (formation, who starts where, when it was shared with the families);
 * - the coach's game log: the score as the side saw it, the timeline (goals with scorer and
 *   assist, substitutions, the opponent's goals, half time) and each player's minutes. It is never
 *   the result: the result is the official's report published by the league (SPK-RESULT-001/002);
 *   the official's report is checked against the game logs (`GET /fixtures/{id}/game-logs`).
 *
 * The side's captain (the team's coach), league staff, and for the game logs an accepted official
 * of the fixture, may use these. Identifiers only in events (§4.14).
 */

/** "2-3-1": outfield lines from the back; the goalkeeper is slot 1 and not written. */
export const FormationSchema = z
  .string()
  .regex(/^[1-9](-[1-9]){1,3}$/, 'a formation reads like 2-3-1')
  .openapi('Formation');

/** Starting places a formation holds: its outfield players plus the goalkeeper. */
export function formationPlaces(formation: string): number {
  return formation.split('-').reduce((sum, n) => sum + Number(n), 0) + 1;
}

export const LineupSlotSchema = z
  .object({ slot: z.number().int().min(1).max(11), personId: z.uuid() })
  .openapi('LineupSlot');
export type LineupSlot = z.infer<typeof LineupSlotSchema>;

export const LineupSchema = z
  .object({
    id: z.uuid(),
    formation: FormationSchema,
    slots: z.array(LineupSlotSchema),
    sharedAt: Instant.nullable(),
    /** True when the lineup changed after it was last shared. */
    changedSinceShared: z.boolean(),
    revision: Revision,
    updatedAt: Instant,
  })
  .openapi('Lineup');
export type Lineup = z.infer<typeof LineupSchema>;

export const GameLogEventSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('goal'),
      minute: z.number().int().min(0).max(150),
      personId: z.uuid().nullable(),
      assistPersonId: z.uuid().nullable(),
    }),
    z.object({ kind: z.literal('opponent_goal'), minute: z.number().int().min(0).max(150) }),
    z.object({
      kind: z.literal('substitution'),
      minute: z.number().int().min(0).max(150),
      offPersonId: z.uuid(),
      onPersonId: z.uuid(),
    }),
    z.object({ kind: z.literal('half_time'), minute: z.number().int().min(0).max(150) }),
  ])
  .openapi('GameLogEvent');
export type GameLogEvent = z.infer<typeof GameLogEventSchema>;

export const PlayerMinutesSchema = z
  .object({ personId: z.uuid(), minutes: z.number().int().min(0).max(150) })
  .openapi('PlayerMinutes');
export type PlayerMinutes = z.infer<typeof PlayerMinutesSchema>;

export const GameLogSchema = z
  .object({
    id: z.uuid(),
    teamEntryId: z.uuid(),
    homeScore: z.number().int(),
    awayScore: z.number().int(),
    events: z.array(GameLogEventSchema),
    minutes: z.array(PlayerMinutesSchema),
    recordedAt: Instant,
    revision: Revision,
  })
  .openapi('GameLog');
export type GameLog = z.infer<typeof GameLogSchema>;

export const TeamSheetPlayerSchema = z
  .object({
    personId: z.uuid(),
    displayName: z.string(),
    jerseyNumber: z.number().int().nullable(),
    /** The player's own answer for this fixture (SPK-CAP-003); `no_response` when none. */
    availability: AvailabilityStateSchema,
    /** Minutes in this season's game logs of the side, before this fixture. */
    minutesThisSeason: z.number().int(),
    gamesThisSeason: z.number().int(),
  })
  .openapi('TeamSheetPlayer');
export type TeamSheetPlayer = z.infer<typeof TeamSheetPlayerSchema>;

export const TeamSheetSchema = z
  .object({
    fixtureId: z.uuid(),
    teamEntryId: z.uuid(),
    side: z.enum(['home', 'away']),
    teamName: z.string(),
    opponentName: z.string().nullable(),
    scheduledStart: Instant.nullable(),
    scheduledEnd: Instant.nullable(),
    fixtureStatus: FixtureStatusSchema,
    /** IANA zone of the venue (SPK-SCHED-008), or null when the fixture has no venue yet. */
    timezone: z.string().nullable(),
    venueName: z.string().nullable(),
    players: z.array(TeamSheetPlayerSchema),
    /** The side's average minutes per rostered player this season (0 before any game log). */
    teamAverageMinutes: z.number(),
    lineup: LineupSchema.nullable(),
    gameLog: GameLogSchema.nullable(),
    /** The official result once the league published it (SPK-RESULT-002), else null. */
    officialResult: z
      .object({
        homeScore: z.number().int().nullable(),
        awayScore: z.number().int().nullable(),
        /** True when it matches the side's game log score (null without a game log). */
        matchesGameLog: z.boolean().nullable(),
      })
      .nullable(),
    /** Commands the viewer may use now on this side. */
    availableActions: z.array(z.enum(['save_lineup', 'share_lineup', 'record_game_log'])),
  })
  .openapi('TeamSheet');
export type TeamSheet = z.infer<typeof TeamSheetSchema>;

export const TeamSheetQuery = z.object({
  /** The side; defaults to the one side the viewer captains. */
  teamEntryId: z.uuid().optional(),
});
export type TeamSheetQuery = z.infer<typeof TeamSheetQuery>;

/** `POST /v1/fixtures/{id}/lineup`: save the side's lineup (create, or change with a revision). */
export const SaveLineupBody = withCommandMeta({
  teamEntryId: z.uuid(),
  formation: FormationSchema,
  slots: z.array(LineupSlotSchema).max(11),
}).openapi('SaveLineupRequest');
export type SaveLineupInput = z.infer<typeof SaveLineupBody>;

/** `POST /v1/fixtures/{id}/lineup/share`: send the saved lineup to the side's families. */
export const ShareLineupBody = withCommandMeta({ teamEntryId: z.uuid() })
  .extend({ expectedRevision: Revision })
  .openapi('ShareLineupRequest');
export type ShareLineupInput = z.infer<typeof ShareLineupBody>;

/** `POST /v1/fixtures/{id}/game-log`: record (or correct, with a revision) the side's game log. */
export const RecordGameLogBody = withCommandMeta({
  teamEntryId: z.uuid(),
  homeScore: z.number().int().min(0).max(99),
  awayScore: z.number().int().min(0).max(99),
  events: z.array(GameLogEventSchema).max(200),
  minutes: z.array(PlayerMinutesSchema).max(40),
}).openapi('RecordGameLogRequest');
export type RecordGameLogInput = z.infer<typeof RecordGameLogBody>;

/** `GET /v1/fixtures/{id}/game-logs`: the sides' scores, for the official's match check. */
export const FixtureGameLogsSchema = z
  .object({
    fixtureId: z.uuid(),
    logs: z.array(
      z.object({
        teamEntryId: z.uuid(),
        teamName: z.string(),
        homeScore: z.number().int(),
        awayScore: z.number().int(),
        recordedAt: Instant,
      }),
    ),
  })
  .openapi('FixtureGameLogs');
export type FixtureGameLogs = z.infer<typeof FixtureGameLogsSchema>;

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
      200: ok('Command outcome', response),
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
  '/fixtures/{id}/lineup',
  "The coach's team sheet: players with answers and season minutes, the lineup and the game log",
  TeamSheetQuery,
  TeamSheetSchema,
);
command(
  '/fixtures/{id}/lineup',
  "Save a side's lineup for the fixture (SPK-CAP-001)",
  SaveLineupBody,
  LineupSchema,
);
command(
  '/fixtures/{id}/lineup/share',
  "Send the side's saved lineup to its families (SPK-CAP-001)",
  ShareLineupBody,
  LineupSchema,
);
command(
  '/fixtures/{id}/game-log',
  "Record the side's game log: score, timeline and minutes (SPK-UX-007, SPK-RESULT-001)",
  RecordGameLogBody,
  GameLogSchema,
);
query(
  '/fixtures/{id}/game-logs',
  "The sides' game log scores, for the official's match check (SPK-RESULT-001)",
  null,
  FixtureGameLogsSchema,
);
