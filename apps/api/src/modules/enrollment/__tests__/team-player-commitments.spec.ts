import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingUniformFixture, createProgramFixture } from '../../catalog';
import {
  TEAM_PLAYER_COMMITMENTS_PORT,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type TeamPlayerCommitmentsPort,
} from '../../competition';
import {
  acknowledge,
  adult,
  enrollmentTestApp,
  key,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

/**
 * SPK-COMP-006 (QA M-5): enrollment answers competition's `TEAM_PLAYER_COMMITMENTS_PORT` from its
 * own registrations and uniform orders, and the command that moves a team onto the waiting list
 * says what its players hold. Nothing is canceled or refunded by the move.
 */
describe("what a waiting team's players hold (SPK-COMP-006, QA M-5)", () => {
  let t: TestApp;
  let programManager: Actor;
  let leagueManager: Actor;
  let port: TeamPlayerCommitmentsPort;
  let season: OfferingSetup;
  let uniformId: string;
  let seasonId: string;

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['pickup_sessions', 'uniforms', 'team_waitlist'] });
    programManager = await staff(t, ['program_manager']);
    leagueManager = await staff(t, ['league_manager']);
    port = t.app.get<TeamPlayerCommitmentsPort>(TEAM_PLAYER_COMMITMENTS_PORT, { strict: false });
    const program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    season = await offering(t, {
      programId: program,
      kind: 'season',
      capacityUnits: [{ unit: 'roster_places', limit: 100 }],
      basePriceMinor: 0,
    });
    uniformId = await createOfferingUniformFixture(t, {
      offeringId: season.offeringId,
      sizes: ['M', 'L'],
      requirement: 'optional',
      priceMinor: null,
    });
    seasonId = (await createSeasonFixture(t, { status: 'open' })).seasonId;
  });
  afterAll(async () => {
    await t.close();
  });

  /** An applied entry without a place: players may already register to join it. */
  async function team(name: string): Promise<string> {
    const entry = await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: (await adult(t)).personId,
      teamName: name,
      status: 'applied',
    });
    return entry.teamEntryId;
  }

  /** A player registers to join the team; `confirm` takes the registration to confirmed. */
  async function join(
    teamEntryId: string,
    options: { uniform?: boolean; confirm?: boolean } = {},
  ): Promise<{ enrollmentId: string | null }> {
    const player = await adult(t, { dateOfBirth: '1995-01-01' });
    await acknowledge(t, season, player.personId, player.personId);
    const basket = await post(t, '/v1/baskets', player.header, {
      fulfillmentMode: 'all_or_nothing',
    });
    const basketId = basket.body.id as string;
    const line = await post(t, `/v1/baskets/${basketId}/lines`, player.header, {
      participantPersonId: player.personId,
      offeringId: season.offeringId,
      intent: 'join_team',
      teamEntryId,
      ...(options.uniform ? { uniform: { offeringUniformId: uniformId, size: 'M' } } : {}),
    });
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    const held = await post(t, `/v1/baskets/${basketId}/hold`, player.header, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    if (options.confirm === false) return { enrollmentId: null };
    const applicationId = held.body.lines[0].applicationId as string;
    const accepted = await post(
      t,
      `/v1/applications/${applicationId}/accept`,
      programManager.header,
      { expectedRevision: 1 },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const done = await post(t, `/v1/baskets/${basketId}/complete`, player.header, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return { enrollmentId: done.body.lines[0].enrollmentId as string };
  }

  it('SPK-COMP-006: the port counts the confirmed registrations and the live uniform orders of one team entry, and nothing of another team, an unconfirmed registration, an unknown entry or another organization', async () => {
    const alpha = await team('Alpha');
    const beta = await team('Beta');
    await join(alpha, { uniform: true });
    await join(alpha);
    // held, not confirmed: no charge yet, so it is not counted as a registration
    await join(alpha, { confirm: false });
    await join(beta, { uniform: true });

    expect(await port.commitmentsOfEntry(t.organizationId, alpha)).toEqual({
      confirmedRegistrations: 2,
      uniformOrders: 1,
    });
    expect(await port.commitmentsOfEntry(t.organizationId, beta)).toEqual({
      confirmedRegistrations: 1,
      uniformOrders: 1,
    });
    expect(await port.commitmentsOfEntry(t.organizationId, newId())).toEqual({
      confirmedRegistrations: 0,
      uniformOrders: 0,
    });
    const other = await seedOrganization(t.db);
    expect(await port.commitmentsOfEntry(other.organizationId, alpha)).toEqual({
      confirmedRegistrations: 0,
      uniformOrders: 0,
    });

    // A canceled uniform order is no longer held.
    await t.db
      .updateTable('uniform_orders')
      .set({ status: 'canceled', canceled_at: t.clock.now(), cancel_reason: 'test' })
      .where('team_entry_id', '=', beta)
      .execute();
    expect(await port.commitmentsOfEntry(t.organizationId, beta)).toEqual({
      confirmedRegistrations: 1,
      uniformOrders: 0,
    });
  });

  it('SPK-COMP-006: staff who move a team with registered players to waiting are told how many registrations and uniform orders stay, finance gets one exception, and the registrations and orders are left as they are', async () => {
    const divisionId = await createDivisionFixture(t, { seasonId, capacityTeamEntries: 1 });
    await createTeamEntryFixture(t, {
      seasonId,
      captainPersonId: (await adult(t)).personId,
      divisionId,
    });
    const gamma = await team('Gamma');
    const first = await join(gamma, { uniform: true });
    const second = await join(gamma, { uniform: true });
    const revision = (
      await t.db
        .selectFrom('team_entries')
        .select('revision')
        .where('id', '=', gamma)
        .executeTakeFirstOrThrow()
    ).revision;

    const waited = await t.http
      .post(`/v1/team-entries/${gamma}/wait`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ divisionId, expectedRevision: revision });
    expect(waited.status, JSON.stringify(waited.body)).toBe(200);
    expect(waited.body).toMatchObject({
      status: 'waiting',
      playerCommitments: { confirmedRegistrations: 2, uniformOrders: 2 },
    });

    const raised = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue', 'status', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('affected_id', '=', gamma)
      .execute();
    expect(raised).toEqual([
      {
        category: 'competition.waiting_entry_player_commitments',
        owner_queue: 'finance_operator',
        status: 'open',
        details: {
          teamEntryId: gamma,
          seasonId,
          waitingDivisionId: divisionId,
          cause: 'staff',
          confirmedRegistrations: 2,
          uniformOrders: 2,
        },
      },
    ]);

    // No money or registration changed: both players stay confirmed and both uniforms stay ordered.
    const enrollments = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('id', 'in', [first.enrollmentId as string, second.enrollmentId as string])
      .execute();
    expect(enrollments.map((row) => row.status)).toEqual(['confirmed', 'confirmed']);
    const orders = await t.db
      .selectFrom('uniform_orders')
      .select('status')
      .where('team_entry_id', '=', gamma)
      .execute();
    expect(orders).toHaveLength(2);
    expect(orders.every((order) => order.status !== 'canceled')).toBe(true);
  });
});
