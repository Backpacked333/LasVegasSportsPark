import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import { CompetitionKindSchema, SportFormatSchema } from './competition';
import { DateOnly } from './identity';
import {
  PUBLIC_NOT_AVAILABLE,
  PublicCode,
  PublicOrganizationSlug,
  PublicScoreSchema,
} from './scheduling-public';

/**
 * Public competition views (SPK-SCHED-010, proposed amendment PA-06; capability `public_schedule`,
 * pending DEC-100): fixtures, results, standings and, in a tournament, the bracket of a
 * competition the operator has made public. The shapes are written for this surface only: team
 * names, scores, times and field names; no person, no contact, no internal id (ADR-005). A
 * competition is private until a permitted staff member publishes it, and one with a division
 * for players under 18 cannot be published.
 */

export const PublicFixtureStatusSchema = z
  .enum(['unscheduled', 'scheduled', 'played', 'forfeit', 'canceled', 'abandoned', 'postponed'])
  .openapi('PublicFixtureStatus');

export const PublicFixtureSchema = z
  .object({
    round: z.number().int().nullable(),
    startsAt: Instant.nullable(),
    endsAt: Instant.nullable(),
    /** IANA zone of the venue; null while the game has no venue. */
    timezone: z.string().nullable(),
    /** Names of the fields the game is played on. */
    fields: z.array(z.string()),
    status: PublicFixtureStatusSchema,
    home: z.string(),
    /** Null is a bye. */
    away: z.string().nullable(),
    /** The official result; null until one is published. */
    score: PublicScoreSchema.nullable(),
  })
  .openapi('PublicFixture');
export type PublicFixture = z.infer<typeof PublicFixtureSchema>;

export const PublicStandingsRowSchema = z
  .object({
    position: z.number().int(),
    team: z.string(),
    played: z.number().int(),
    won: z.number().int(),
    drawn: z.number().int(),
    lost: z.number().int(),
    goalsFor: z.number().int(),
    goalsAgainst: z.number().int(),
    goalDifference: z.number().int(),
    points: z.number().int(),
  })
  .openapi('PublicStandingsRow');
export type PublicStandingsRow = z.infer<typeof PublicStandingsRowSchema>;

export const PublicDivisionSchema = z
  .object({
    name: z.string(),
    fixtures: z.array(PublicFixtureSchema),
    standings: z.array(PublicStandingsRowSchema),
  })
  .openapi('PublicDivision');
export type PublicDivision = z.infer<typeof PublicDivisionSchema>;

export const PublicBracketMatchSchema = z
  .object({
    round: z.number().int(),
    slot: z.number().int(),
    division: z.string().nullable(),
    /** Null until the teams of the match are known. */
    home: z.string().nullable(),
    away: z.string().nullable(),
    score: PublicScoreSchema.nullable(),
    winner: z.enum(['home', 'away']).nullable(),
    startsAt: Instant.nullable(),
  })
  .openapi('PublicBracketMatch');
export type PublicBracketMatch = z.infer<typeof PublicBracketMatchSchema>;

export const PublicSeasonViewSchema = z
  .object({
    organizationName: z.string(),
    competitionName: z.string(),
    competitionKind: CompetitionKindSchema,
    sportFormat: SportFormatSchema,
    seasonName: z.string(),
    startsOn: DateOnly,
    endsOn: DateOnly,
    divisions: z.array(PublicDivisionSchema),
    /** Games of the season that belong to no division. */
    otherFixtures: z.array(PublicFixtureSchema),
    /** The published bracket of a tournament; null for a league or before it is published. */
    bracket: z.array(PublicBracketMatchSchema).nullable(),
    computedAt: Instant,
    cacheSeconds: z.number().int(),
  })
  .openapi('PublicSeasonView');
export type PublicSeasonView = z.infer<typeof PublicSeasonViewSchema>;

export const PublicCompetitionViewSchema = z
  .object({
    organizationName: z.string(),
    name: z.string(),
    kind: CompetitionKindSchema,
    sportFormat: SportFormatSchema,
    /** The seasons with their public codes, newest first. */
    seasons: z.array(
      z.object({ code: PublicCode, name: z.string(), startsOn: DateOnly, endsOn: DateOnly }),
    ),
    computedAt: Instant,
    cacheSeconds: z.number().int(),
  })
  .openapi('PublicCompetitionView');
export type PublicCompetitionView = z.infer<typeof PublicCompetitionViewSchema>;

// ---------------------------------------------------------------------------------------------
// Staff: making a competition public or private, and its links
// ---------------------------------------------------------------------------------------------
export const CompetitionPublicationSchema = z
  .object({
    competitionId: z.uuid(),
    visibility: z.enum(['private', 'public']),
    organizationSlug: z.string(),
    /** Null until the competition has been made public once. */
    publicCode: PublicCode.nullable(),
    changedAt: Instant.nullable(),
    seasons: z.array(
      z.object({ seasonId: z.uuid(), name: z.string(), publicCode: PublicCode.nullable() }),
    ),
    /**
     * Divisions whose criteria describe players under 18: while any is listed the competition
     * cannot be made public, and a public one answers "not available" (proposed rule, DEC-100).
     */
    minorDivisions: z.array(z.object({ seasonName: z.string(), divisionName: z.string() })),
    revision: Revision,
  })
  .openapi('CompetitionPublication');
export type CompetitionPublication = z.infer<typeof CompetitionPublicationSchema>;

export const ChangeCompetitionPublicationBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('ChangeCompetitionPublicationRequest');
export type ChangeCompetitionPublicationInput = z.infer<typeof ChangeCompetitionPublicationBody>;

// ---------------------------------------------------------------------------------------------
// OpenAPI registration
// ---------------------------------------------------------------------------------------------
const TAG = 'Public views';
const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});
const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});
const idempotencyHeader = z.object({ 'Idempotency-Key': z.string().min(8).max(128) });
const IdParams = z.object({ id: z.uuid() });
const PublicParams = z.object({ organization: PublicOrganizationSlug, code: PublicCode });

function publicRead(path: string, summary: string, response: z.ZodType) {
  openApiRegistry.registerPath({
    method: 'get',
    path,
    summary,
    tags: [TAG],
    security: [],
    request: { params: PublicParams },
    responses: {
      200: ok('The view (cacheable for a short time)', response),
      400: err('Validation failed'),
      404: err(PUBLIC_NOT_AVAILABLE),
      429: err('Too many public reads from this address (rate limit `public_views`)'),
    },
  });
}

publicRead(
  '/public/{organization}/competitions/{code}',
  'A public competition and the codes of its seasons, without sign-in (SPK-SCHED-010, Proposed)',
  PublicCompetitionViewSchema,
);
publicRead(
  '/public/{organization}/seasons/{code}',
  'Fixtures, results, standings and bracket of a season of a public competition, without sign-in (SPK-SCHED-010, Proposed)',
  PublicSeasonViewSchema,
);

openApiRegistry.registerPath({
  method: 'get',
  path: '/competitions/{id}/publication',
  summary:
    'Whether a competition is public, its links and what blocks it (SPK-SCHED-010, Proposed)',
  tags: ['Competition'],
  request: { params: IdParams },
  responses: {
    200: ok('Result', CompetitionPublicationSchema),
    403: err('Access denied'),
    404: err('Not found or not visible'),
  },
});
for (const [action, summary] of [
  ['publish', 'Make a competition public (SPK-SCHED-010, Proposed)'],
  ['unpublish', 'Make a competition private again (SPK-SCHED-010, Proposed)'],
] as const) {
  openApiRegistry.registerPath({
    method: 'post',
    path: `/competitions/{id}/${action}`,
    summary,
    tags: ['Competition'],
    request: {
      params: IdParams,
      headers: idempotencyHeader,
      body: { content: { 'application/json': { schema: ChangeCompetitionPublicationBody } } },
    },
    responses: {
      200: ok('Command outcome', CompetitionPublicationSchema),
      400: err('Validation failed (a division for players under 18)'),
      403: err('Access denied, or public views are not enabled (CAPABILITY_DISABLED)'),
      404: err('Not found or not visible'),
      409: err('Conflict (STALE_REVISION, IDEMPOTENCY_*)'),
    },
  });
}
