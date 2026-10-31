import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../kernel';
import { createTestApp, type TestApp } from '../testing';
import { DOMAIN_MODULES } from '../modules';
import { createAcknowledgmentFixture, createOfferingFixture } from '../modules/catalog';
import { DeliveryWorker } from '../modules/communications';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../modules/competition';
import {
  CLOCK_START,
  adultCustomer,
  key,
  staffMember,
  type Actor,
} from '../modules/competition/__tests__/support';
import { FINANCIAL_STANDING_PORT, type FinancialStandingPort } from '../modules/entry';
import { createObligationFixture } from '../modules/finance';
import { at, seedPitchWithHalves, type PitchFixture } from '../modules/scheduling';

interface Readiness {
  status: string;
  checks: Array<{ name: string; status: string }>;
  issues: Array<{ code: string; severity: string; message: string }>;
}

/**
 * SPK-READY-001/002, SPK-ENTRY-004, §4.2: in the assembled application (every domain module, as
 * AppModule loads them) the readiness and arrival ports answer from the modules that own the
 * evidence — enrollment over catalog (required forms), finance (team obligations, participant
 * standing) and communications (change-notice delivery) — instead of their `unknown` defaults.
 */
describe('cross-module readiness and arrival ports in the assembled application', () => {
  let t: TestApp;
  let lm: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let divisionId: string;
  let formPolicyVersionId: string;
  const entries: string[] = [];
  let fixtureId: string;

  const readiness = async (): Promise<Readiness> => {
    const res = await t.http.get(`/v1/fixtures/${fixtureId}/readiness`).set(lm.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Readiness;
  };
  const check = (r: Readiness, name: string) => r.checks.find((c) => c.name === name)?.status;
  const codes = (r: Readiness) => r.issues.map((i) => `${i.code}:${i.severity}`);
  const player = async (teamEntryId: string, acknowledged: boolean) => {
    const person = await adultCustomer(t);
    await addRosterMemberFixture(t, { teamEntryId, personId: person.personId });
    if (acknowledged) {
      await createAcknowledgmentFixture(t, {
        subjectPersonId: person.personId,
        policyVersionId: formPolicyVersionId,
        signedByPersonId: person.personId,
      });
    }
    return person;
  };
  const drain = async () => {
    const dispatcher = t.app.get(OutboxDispatcher);
    for (let i = 0; i < 20; i += 1) if ((await dispatcher.runOnce(200)).claimed === 0) return;
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: CLOCK_START,
    });
    lm = await staffMember(t, ['league_manager']);
    const manager = await staffMember(t, ['program_manager']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: manager.personId,
    });
    formPolicyVersionId = offering.formPolicyVersionId;
    season = await createSeasonFixture(t, {
      status: 'active',
      registrationOfferingRef: offering.offeringId,
    });
    divisionId = await createDivisionFixture(t, { seasonId: season.seasonId });
    for (const name of ['Home', 'Away']) {
      const captain = await adultCustomer(t);
      const entry = await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain.personId,
        teamName: name,
        divisionId,
      });
      await addRosterMemberFixture(t, {
        teamEntryId: entry.teamEntryId,
        personId: captain.personId,
      });
      await createAcknowledgmentFixture(t, {
        subjectPersonId: captain.personId,
        policyVersionId: formPolicyVersionId,
        signedByPersonId: captain.personId,
      });
      for (let i = 1; i < season.ruleSet.minimumPlayers + 1; i += 1) {
        await player(entry.teamEntryId, true);
      }
      entries.push(entry.teamEntryId);
    }
    const created = await t.http
      .post('/v1/fixtures')
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        divisionId,
        homeEntryId: entries[0],
        awayEntryId: entries[1],
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-01-16', '18:00'),
          scheduledEnd: at('2027-01-16', '19:00'),
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    fixtureId = created.body.fixture.id as string;
    await drain();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('SPK-READY-001/002: a published fixture with acknowledged forms and no open team obligation is ready', async () => {
    const r = await readiness();
    expect(check(r, 'forms')).toBe('ready');
    expect(check(r, 'finance')).toBe('ready');
    expect(codes(r).filter((c) => c.endsWith(':unknown') || c.endsWith(':blocking'))).toEqual([]);
    expect(r.status).toBe('ready');
  });

  it('SPK-READY-001: a rostered player without the required form blocks, by count only', async () => {
    const late = await player(entries[0] as string, false);
    const blocked = await readiness();
    expect(blocked.status).toBe('blocked');
    const issue = blocked.issues.find((i) => i.code === 'required_form_missing');
    expect(issue).toMatchObject({ severity: 'blocking' });
    expect(issue?.message).toMatch(/^1 rostered participant/);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: late.personId,
      policyVersionId: formPolicyVersionId,
      signedByPersonId: late.personId,
    });
    expect((await readiness()).status).toBe('ready');
  });

  it('SPK-READY-001 / POL-017: an open team obligation is unknown, never a pass or a block', async () => {
    await createObligationFixture(t, { debtorTeamEntryId: entries[1], amountMinor: 25_000 });
    const r = await readiness();
    expect(r.status).toBe('unknown');
    const issue = r.issues.find((i) => i.code === 'team_balance_policy_pending');
    expect(issue).toMatchObject({ severity: 'unknown' });
    expect(issue?.message).toContain('POL-017');
  });

  it('SPK-READY-001 / SPK-AT-009: after a reschedule the change-notice check is unknown until the notice is accepted', async () => {
    const fixture = await t.http.get(`/v1/fixtures/${fixtureId}`).set(lm.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: fixture.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-01-23', '18:00'),
          scheduledEnd: at('2027-01-23', '19:00'),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const before = await readiness();
    expect(check(before, 'notifications')).toBe('unknown');
    await drain();
    await t.app.get(DeliveryWorker).runOnce();
    await drain();
    const after = await readiness();
    expect(
      after.issues.filter((i) => i.code.startsWith('change_notification')),
      JSON.stringify(after.issues),
    ).toEqual([]);
    expect(check(after, 'notifications')).toBe('ready');
  });

  it('SPK-ENTRY-004: the arrival standing comes from finance (clear, or an outstanding unrelated balance)', async () => {
    const standing = t.app.get<FinancialStandingPort>(FINANCIAL_STANDING_PORT, { strict: false });
    const clear = await adultCustomer(t);
    expect(
      await standing.standingOf(t.organizationId, clear.personId, {
        offeringId: null,
        at: t.clock.now(),
      }),
    ).toEqual({ status: 'clear' });
    const owing = await adultCustomer(t);
    const obligationId = await createObligationFixture(t, {
      debtorPersonId: owing.personId,
      amountMinor: 4_000,
      dueAt: new Date(t.clock.now().getTime() - 86_400_000),
    });
    expect(
      await standing.standingOf(t.organizationId, owing.personId, {
        offeringId: null,
        at: t.clock.now(),
      }),
    ).toEqual({
      status: 'outstanding',
      related: false,
      amountMinor: 4_000,
      currency: 'USD',
      reference: obligationId,
    });
  });
});
