import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingSessionFixture } from '../../catalog';
import { createSeasonFixture } from '../../competition';
import { definitionWithScope } from './package-g-support';
import {
  adult,
  child,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

type Answer = { status: number; body: Record<string, unknown> };

/** The answer without what differs per request (the correlation id). */
const comparable = (answer: Answer) => {
  const { correlationId: _ignored, ...rest } = answer.body;
  return { status: answer.status, body: rest };
};

/**
 * R4-PRIVACY-03 (§4.10 "errors must not reveal another household's protected record existence";
 * CLAUDE.md: a customer-private record the caller may not see answers protectedNotFound): every
 * enrollment command that names a person by id (participant, booker, basket owner) answers a
 * caller who may not even read that person exactly as it answers an id that names nobody, so a
 * person id seen elsewhere cannot be confirmed. A caller who may read the person but lacks the
 * command's authority still gets the honest PARTICIPANT_AUTHORITY_REQUIRED.
 */
describe('§4.10 (R4-PRIVACY-03): a command naming another household person answers as for an unknown id', () => {
  let t: TestApp;
  let parent: Actor;
  let stranger: Actor;
  let kid: string;
  let setup: OfferingSetup;
  let rental: OfferingSetup;
  let sessionId: string;
  let seasonId: string;
  let strangerBasketId: string;

  beforeAll(async () => {
    t = await enrollmentTestApp();
    parent = await adult(t);
    stranger = await adult(t);
    kid = await child(t, [parent]);
    setup = await offering(t);
    sessionId = await createOfferingSessionFixture(t, {
      offeringId: setup.offeringId,
      scheduledStart: new Date('2026-11-25T01:00:00Z'),
      scheduledEnd: new Date('2026-11-25T02:00:00Z'),
    });
    rental = await offering(t, {
      kind: 'rental',
      entitlementDefinitionId: await definitionWithScope(t, 'rental_resource', {
        resources: { resourceIds: [newId()], count: 1 },
        staffing: [],
      }),
      basePriceMinor: 0,
      ageBand: { minAgeYears: 18 },
    });
    seasonId = (await createSeasonFixture(t)).seasonId;
    const basket = await post(t, '/v1/baskets', stranger.header, {
      fulfillmentMode: 'all_or_nothing',
    });
    expect(basket.status, JSON.stringify(basket.body)).toBe(201);
    strangerBasketId = basket.body.id as string;
  });
  afterAll(async () => {
    await t.close();
  });

  const commands: Array<[string, () => string, (personId: string) => Record<string, unknown>]> = [
    [
      'POST /v1/applications',
      () => '/v1/applications',
      (personId) => ({
        offeringId: setup.offeringId,
        participantPersonId: personId,
        intent: 'youth',
      }),
    ],
    [
      'POST /v1/waitlist-entries',
      () => '/v1/waitlist-entries',
      (personId) => ({
        offeringId: setup.offeringId,
        participantPersonId: personId,
        intent: 'youth',
      }),
    ],
    [
      'POST /v1/trial-participations',
      () => '/v1/trial-participations',
      (personId) => ({ offeringId: setup.offeringId, participantPersonId: personId, sessionId }),
    ],
    [
      'POST /v1/session-bookings',
      () => '/v1/session-bookings',
      (personId) => ({ offeringId: setup.offeringId, sessionId, participantPersonId: personId }),
    ],
    [
      'POST /v1/placement-requests',
      () => '/v1/placement-requests',
      (personId) => ({ participantPersonId: personId, seasonId }),
    ],
    [
      'POST /v1/bookings (bookerPersonId)',
      () => '/v1/bookings',
      (personId) => ({
        offeringId: rental.offeringId,
        start: '2026-12-01T18:00:00.000Z',
        end: '2026-12-01T19:00:00.000Z',
        resourceIds: [newId()],
        bookerPersonId: personId,
      }),
    ],
    [
      'POST /v1/baskets (ownerPersonId)',
      () => '/v1/baskets',
      (personId) => ({ ownerPersonId: personId, fulfillmentMode: 'all_or_nothing' }),
    ],
    [
      'POST /v1/baskets/{id}/lines',
      () => `/v1/baskets/${strangerBasketId}/lines`,
      (personId) => ({
        participantPersonId: personId,
        offeringId: setup.offeringId,
        intent: 'youth',
      }),
    ],
  ];

  for (const [name, path, body] of commands) {
    it(`§4.10 (R4-PRIVACY-03): ${name} answers another household's person exactly as an unknown id`, async () => {
      const other = await post(t, path(), stranger.header, body(kid));
      const unknown = await post(t, path(), stranger.header, body(newId()));
      expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);
      expect(unknown.body.code).toBe('NOT_FOUND');
      expect(comparable(other)).toEqual(comparable(unknown));
    });
  }

  it('§4.10 / SPK-IAM-003 (R4-PRIVACY-03): whoever may read the person but not register them is told PARTICIPANT_AUTHORITY_REQUIRED, never NOT_FOUND', async () => {
    const viewer = await adult(t);
    const viewOnly = await child(t, [viewer], { permissions: ['view'] });
    const refused = await post(t, '/v1/applications', viewer.header, {
      offeringId: setup.offeringId,
      participantPersonId: viewOnly,
      intent: 'youth',
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    // A staff reader (identity.read_person) whose roles do not register is not told the person
    // does not exist.
    const scheduler = await staff(t, ['scheduler']);
    const denied = await post(t, '/v1/applications', scheduler.header, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      intent: 'youth',
    });
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
  });

  it('SPK-PLACE-005 / §4.10 (R4-PRIVACY-03): a requested teammate is recorded by id whether or not the id names a person', async () => {
    const strangerKid = await child(t, [stranger]);
    const first = await child(t, [parent]);
    const second = await child(t, [parent]);
    const known = await post(t, '/v1/placement-requests', parent.header, {
      participantPersonId: first,
      seasonId,
      requestedTeammatePersonIds: [strangerKid],
    });
    const nobody = newId();
    const unknown = await post(t, '/v1/placement-requests', parent.header, {
      participantPersonId: second,
      seasonId,
      requestedTeammatePersonIds: [nobody],
    });
    expect(known.status, JSON.stringify(known.body)).toBe(201);
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(201);
    expect(known.body.requestedTeammatePersonIds).toEqual([strangerKid]);
    expect(unknown.body.requestedTeammatePersonIds).toEqual([nobody]);
  });
});
