import { z } from '../zod';
import { Revision, withCommandMeta } from '../commands';
import { ErrorResponseSchema, openApiRegistry } from '../openapi';
import { Instant } from '../time';
import { TeamEntryPlaceOfferSchema, TeamEntrySchema } from './competition';

/**
 * Team waiting list (SPK-COMP-006, proposed amendment PA-10; capability `team_waitlist`, pending
 * DEC-104). A waiting entry keeps its order, holds no place and owes nothing; staff offer a freed
 * place to the waiting entry they choose, with the list order shown; the offer expires; accepting
 * it moves the entry into the ordinary approval and payment path (SPK-COMP-004).
 */

const Note = z.string().trim().min(1).max(2000);
const Reason = z.string().trim().min(1).max(1000);

/** Staff: move an applied entry without a place onto the waiting list. */
export const WaitTeamEntryBody = withCommandMeta({
  /** The full division to wait for; omitted waits for any place in the season. */
  divisionId: z.uuid().optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('WaitTeamEntryRequest');
export type WaitTeamEntryInput = z.infer<typeof WaitTeamEntryBody>;

/** Staff: offer a free place to the waiting entry they choose. */
export const OfferTeamPlaceBody = withCommandMeta({
  /** The division whose place is offered; defaults to the division the entry waits for. */
  divisionId: z.uuid().optional(),
  note: Note.optional(),
})
  .extend({ expectedRevision: Revision })
  .openapi('OfferTeamPlaceRequest');
export type OfferTeamPlaceInput = z.infer<typeof OfferTeamPlaceBody>;

export const AcceptTeamPlaceOfferBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('AcceptTeamPlaceOfferRequest');
export type AcceptTeamPlaceOfferInput = z.infer<typeof AcceptTeamPlaceOfferBody>;

export const DeclineTeamPlaceOfferBody = withCommandMeta({})
  .extend({ expectedRevision: Revision })
  .openapi('DeclineTeamPlaceOfferRequest');
export type DeclineTeamPlaceOfferInput = z.infer<typeof DeclineTeamPlaceOfferBody>;

export const WithdrawTeamPlaceOfferBody = withCommandMeta({})
  .extend({ expectedRevision: Revision, reason: Reason })
  .openapi('WithdrawTeamPlaceOfferRequest');
export type WithdrawTeamPlaceOfferInput = z.infer<typeof WithdrawTeamPlaceOfferBody>;

/** The outcome of an offer command: the offer and the entry as they now stand. */
export const TeamPlaceOfferOutcomeSchema = z
  .object({ offer: TeamEntryPlaceOfferSchema, entry: TeamEntrySchema })
  .openapi('TeamPlaceOfferOutcome');
export type TeamPlaceOfferOutcome = z.infer<typeof TeamPlaceOfferOutcomeSchema>;

export const WaitingListEntrySchema = z
  .object({
    /** 1 is the entry that has waited longest on this list. */
    position: z.number().int(),
    teamEntryId: z.uuid(),
    teamId: z.uuid(),
    teamName: z.string(),
    waitingSince: Instant,
    /** The entry's revision, for the offer command. */
    revision: Revision,
    openOffer: TeamEntryPlaceOfferSchema.nullable(),
  })
  .openapi('WaitingListEntry');
export type WaitingListEntry = z.infer<typeof WaitingListEntrySchema>;

/**
 * One list of a season: the entries waiting for one division, or (division null) for any place in
 * the season. `capacity` null is a division without a limit; `freePlaces` is what staff can offer
 * now (capacity less placed entries less open offers), null where it does not apply.
 */
export const WaitingListSchema = z
  .object({
    division: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    capacity: z.number().int().nullable(),
    /** Entries applied or approved in the division. */
    placed: z.number().int().nullable(),
    /** Places held by open offers. */
    openOffers: z.number().int().nullable(),
    freePlaces: z.number().int().nullable(),
    entries: z.array(WaitingListEntrySchema),
  })
  .openapi('WaitingList');
export type WaitingList = z.infer<typeof WaitingListSchema>;

export const SeasonWaitingListsSchema = z
  .object({
    seasonId: z.uuid(),
    /** Hours an offer stands (configuration; 48 by proposed default, DEC-104). */
    offerHours: z.number().int(),
    lists: z.array(WaitingListSchema),
  })
  .openapi('SeasonWaitingLists');
export type SeasonWaitingLists = z.infer<typeof SeasonWaitingListsSchema>;

export const SeasonWaitingListsQuery = z.object({ divisionId: z.uuid().optional() });
export type SeasonWaitingListsQuery = z.infer<typeof SeasonWaitingListsQuery>;

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

function command(
  path: string,
  summary: string,
  body: z.ZodType,
  response: z.ZodType,
  status = 200,
) {
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
      [status]: ok('Command outcome', response),
      400: err('Validation failed'),
      403: err('Access denied, or the team waiting list is not enabled (CAPABILITY_DISABLED)'),
      404: err('Not found or not visible'),
      409: err(
        'Conflict (CAPACITY_UNAVAILABLE, STALE_REVISION, INVALID_TRANSITION, IDEMPOTENCY_*)',
      ),
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

command(
  '/team-entries/{id}/wait',
  'Move an applied entry onto the waiting list of a full division or season (SPK-COMP-006, Proposed)',
  WaitTeamEntryBody,
  TeamEntrySchema,
);
command(
  '/team-entries/{id}/place-offers',
  'Offer a free division place to a waiting entry (SPK-COMP-006, Proposed)',
  OfferTeamPlaceBody,
  TeamPlaceOfferOutcomeSchema,
  201,
);
query(
  '/team-entries/{id}/place-offers',
  'The place offers made to an entry, newest first (SPK-COMP-006, Proposed)',
  null,
  z.array(TeamEntryPlaceOfferSchema),
);
command(
  '/team-entry-place-offers/{id}/accept',
  'Accept a place offer: the entry returns to the approval path in that division (SPK-COMP-006, Proposed)',
  AcceptTeamPlaceOfferBody,
  TeamPlaceOfferOutcomeSchema,
);
command(
  '/team-entry-place-offers/{id}/decline',
  'Decline a place offer; the entry keeps its place in the order (SPK-COMP-006, Proposed)',
  DeclineTeamPlaceOfferBody,
  TeamPlaceOfferOutcomeSchema,
);
command(
  '/team-entry-place-offers/{id}/withdraw',
  'Withdraw an open place offer (staff); the entry keeps its place in the order (SPK-COMP-006, Proposed)',
  WithdrawTeamPlaceOfferBody,
  TeamPlaceOfferOutcomeSchema,
);
query(
  '/seasons/{id}/waiting-list',
  'The waiting lists of a season, per division and in order (SPK-COMP-006, Proposed)',
  SeasonWaitingListsQuery,
  SeasonWaitingListsSchema,
);
