import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
} from '../../modules/catalog';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../modules/competition';
import { FakePaymentTokens } from '../../modules/finance';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createStaffMemberFixture,
} from '../../modules/identity';
import { createTestApp, type TestApp } from '../../testing';

const key = () => `k-${newId()}`;

/**
 * SPK-AT-002 (spec §6.1): "New adult joins a team and pays — verification, approval, payment,
 * roster and placement remain understandable", over the assembled application. The join_team
 * registration is evaluated against the competition's own player eligibility before anything is
 * quoted or charged (SPK-CAP-004, SPK-REG-002); once approved (SPK-REG-007) and paid, the
 * confirmation places the player on the roster in the same transaction (§4.11 step 8). If the
 * rules refuse at confirmation, the payment is kept visible as incomplete fulfillment. Payment for
 * invitation acceptance follows the billing model (DEC-008, pending).
 */
describe('SPK-AT-002: new adult joins a team and pays (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  const send = (path: string, auth: { Authorization: string }, body: object) =>
    t.http.post(path).set(auth).set('Idempotency-Key', key()).send(body);
  const drain = async () => {
    const dispatcher = t.app.get(OutboxDispatcher);
    for (let i = 0; i < 30; i += 1) if ((await dispatcher.runOnce(200)).claimed === 0) return;
  };

  async function league() {
    const manager = await createStaffMemberFixture(t, {
      roles: ['league_manager', 'program_manager'],
    });
    const managerHeader = await authHeaderForPerson(t, manager.personId);
    const season = await createSeasonFixture(t, { status: 'open' });
    const division = await createDivisionFixture(t, { seasonId: season.seasonId });
    const captain = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: captain });
    const comets = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain,
      teamName: `Comets ${newId().slice(-4)}`,
      divisionId: division,
    });
    await addRosterMemberFixture(t, { teamEntryId: comets.teamEntryId, personId: captain });
    const otherCaptain = await createPersonFixture(t, { kind: 'adult' });
    const rockets = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: otherCaptain,
      teamName: `Rockets ${newId().slice(-4)}`,
      divisionId: division,
    });
    const programId = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
      programId,
      kind: 'season',
      basePriceMinor: 9_000,
    });
    const player = await createPersonFixture(t, { kind: 'adult', dateOfBirth: '1990-01-01' });
    await createAccountFixture(t, { personId: player });
    const playerHeader = await authHeaderForPerson(t, player);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: player,
      policyVersionId: offering.formPolicyVersionId,
      signedByPersonId: player,
    });
    return {
      managerHeader,
      captain,
      comets: comets.teamEntryId,
      rockets: rockets.teamEntryId,
      offering,
      player,
      playerHeader,
    };
  }

  const rosterRows = (teamEntryId: string, personId: string) =>
    t.db
      .selectFrom('roster_memberships')
      .select(['id', 'status', 'source', 'effective_to'])
      .where('team_entry_id', '=', teamEntryId)
      .where('person_id', '=', personId)
      .execute();

  async function joinLine(setup: Awaited<ReturnType<typeof league>>) {
    const basket = await send('/v1/baskets', setup.playerHeader, { ownerPersonId: setup.player });
    expect(basket.status, JSON.stringify(basket.body)).toBe(201);
    const line = await send(`/v1/baskets/${basket.body.id as string}/lines`, setup.playerHeader, {
      participantPersonId: setup.player,
      offeringId: setup.offering.offeringId,
      intent: 'join_team',
      teamEntryId: setup.comets,
    });
    return { basketId: basket.body.id as string, line };
  }

  async function approve(setup: Awaited<ReturnType<typeof league>>, applicationId: string) {
    const application = await t.http
      .get(`/v1/applications/${applicationId}`)
      .set(setup.managerHeader);
    const accepted = await send(`/v1/applications/${applicationId}/accept`, setup.managerHeader, {
      expectedRevision: application.body.revision,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  }

  it('SPK-AT-002 / SPK-REG-007 / §4.11: an approved and paid join_team registration places the player on the roster in the confirming transaction', async () => {
    const setup = await league();
    const { basketId, line } = await joinLine(setup);
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    await approve(setup, line.body.lines[0].applicationId as string);
    const quote = await send('/v1/registration-quotes', setup.playerHeader, { basketId });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    expect(quote.body.totalMinor).toBe(9_000);
    const checkout = await send('/v1/registration-checkouts', setup.playerHeader, {
      quoteId: quote.body.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.status).toBe('completed');
    await drain();

    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['id', 'status', 'intent'])
      .where('participant_person_id', '=', setup.player)
      .executeTakeFirstOrThrow();
    expect(enrollment).toMatchObject({ status: 'confirmed', intent: 'join_team' });
    const rows = await rosterRows(setup.comets, setup.player);
    expect(rows).toEqual([
      expect.objectContaining({ status: 'active', source: 'registration', effective_to: null }),
    ]);
    // the two records name each other in the audit trail
    const confirmAudit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', enrollment.id)
      .where('action', '=', 'enrollment.confirm')
      .executeTakeFirstOrThrow();
    expect(confirmAudit.details).toMatchObject({ rosterMembershipId: rows[0]?.id });
    const rosterAudit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', rows[0]?.id as string)
      .executeTakeFirstOrThrow();
    expect(rosterAudit.details).toMatchObject({
      enrollmentId: enrollment.id,
      source: 'registration',
    });
    // the captain's roster shows the paid player
    const roster = await t.http
      .get(`/v1/team-entries/${setup.comets}/roster`)
      .set(setup.managerHeader);
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    expect(JSON.stringify(roster.body)).toContain(setup.player);
  });

  it('SPK-AT-002 / SPK-CAP-004 / SPK-REG-002: a join the competition rules forbid is explained on the basket line and cannot be approved, quoted or charged', async () => {
    const setup = await league();
    // already playing for another team of the same division (multi-team restriction)
    await addRosterMemberFixture(t, { teamEntryId: setup.rockets, personId: setup.player });
    const { basketId, line } = await joinLine(setup);
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    const eligibility = line.body.lines[0].eligibility as {
      eligible: boolean;
      reasons: Array<{ code: string; severity: string; source: unknown }>;
    };
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContainEqual(
      expect.objectContaining({
        code: 'already_in_division',
        severity: 'blocking',
        source: { type: 'team_entry', id: setup.comets },
      }),
    );
    const quote = await send('/v1/registration-quotes', setup.playerHeader, { basketId });
    expect(quote.status, JSON.stringify(quote.body)).toBe(409);
    const applicationId = line.body.lines[0].applicationId as string;
    const application = await t.http
      .get(`/v1/applications/${applicationId}`)
      .set(setup.managerHeader);
    const accepted = await send(`/v1/applications/${applicationId}/accept`, setup.managerHeader, {
      expectedRevision: application.body.revision,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(422);
    expect(accepted.body.code).toBe('ELIGIBILITY_FAILED');
    expect(
      await t.db
        .selectFrom('quotes')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .where('basket_id', '=', basketId)
        .execute(),
    ).toEqual([]);
    expect(await rosterRows(setup.comets, setup.player)).toEqual([]);
  });

  it('SPK-AT-002 / §4.11 step 8: when the rules refuse at confirmation, the received payment stays visible as fulfillment needing recovery; no roster row is written', async () => {
    const setup = await league();
    const { basketId, line } = await joinLine(setup);
    expect(line.status, JSON.stringify(line.body)).toBe(201);
    await approve(setup, line.body.lines[0].applicationId as string);
    const basket = await t.http.get(`/v1/baskets/${basketId}`).set(setup.playerHeader);
    const held = await send(`/v1/baskets/${basketId}/hold`, setup.playerHeader, {
      expectedRevision: basket.body.revision,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const quote = await send('/v1/registration-quotes', setup.playerHeader, { basketId });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    // eligibility changes after the hold and before payment: the player joins another team
    await addRosterMemberFixture(t, { teamEntryId: setup.rockets, personId: setup.player });
    const checkout = await send('/v1/registration-checkouts', setup.playerHeader, {
      quoteId: quote.body.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    await drain();
    const state = await t.http
      .get(`/v1/registration-checkouts/${checkout.body.id as string}`)
      .set(setup.playerHeader);
    expect(state.body.status, JSON.stringify(state.body)).toBe('recovery_required');
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue'])
      .where('organization_id', '=', t.organizationId)
      .where('category', '=', 'finance.fulfillment_incomplete')
      .where('affected_id', '=', checkout.body.id as string)
      .execute();
    expect(exception).toHaveLength(1);
    expect(await rosterRows(setup.comets, setup.player)).toEqual([]);
    const confirmed = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('participant_person_id', '=', setup.player)
      .where('status', '=', 'confirmed')
      .execute();
    expect(confirmed).toEqual([]);
  });
});
