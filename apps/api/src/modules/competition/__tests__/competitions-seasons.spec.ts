import { proposedRuleSetContent } from '../competition.policy';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import {
  createCompetitionFixture,
  createDivisionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../testing/competition-fixtures';
import {
  adultCustomer,
  competitionTestApp,
  isRestrictViolation,
  key,
  staffMember,
  type Actor,
} from './support';

describe('competitions, rule sets, seasons and divisions (SPK-COMP-001, SPK-COMP-002, SPK-COMP-003)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let customer: Actor;

  beforeAll(async () => {
    t = await competitionTestApp();
    leagueManager = await staffMember(t, ['league_manager']);
    frontDesk = await staffMember(t, ['front_desk']);
    customer = await adultCustomer(t);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-COMP-001 / §4.9: a league manager creates a competition; the same key replays, a changed payload conflicts', async () => {
    const k = key();
    const body = { name: 'Monday Futsal', kind: 'league', sportFormat: 'futsal' };
    const res = await t.http
      .post('/v1/competitions')
      .set(leagueManager.header)
      .set('Idempotency-Key', k)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ...body, status: 'draft', revision: 1, description: null });
    const replay = await t.http
      .post('/v1/competitions')
      .set(leagueManager.header)
      .set('Idempotency-Key', k)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(res.body.id);
    const conflict = await t.http
      .post('/v1/competitions')
      .set(leagueManager.header)
      .set('Idempotency-Key', k)
      .send({ ...body, name: 'Tuesday Futsal' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const missingKey = await t.http.post('/v1/competitions').set(leagueManager.header).send(body);
    expect(missingKey.status).toBe(400);
    // audit and outbox follow-up committed with the change
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', res.body.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['competition.manage_competitions']);
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', res.body.id)
      .execute();
    expect(outbox.map((o) => o.event_type)).toEqual(['competition.competition_created']);
    // one competition per name
    const duplicate = await t.http
      .post('/v1/competitions')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send(body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('RESOURCE_CONFLICT');
  });

  it('staff role matrix: front desk and customers read competitions, only league administration manages them', async () => {
    const body = { name: 'Front desk league', kind: 'league', sportFormat: 'outdoor' };
    const denied = await t.http
      .post('/v1/competitions')
      .set(frontDesk.header)
      .set('Idempotency-Key', key())
      .send(body);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ACCESS_DENIED');
    const customerDenied = await t.http
      .post('/v1/competitions')
      .set(customer.header)
      .set('Idempotency-Key', key())
      .send(body);
    expect(customerDenied.status).toBe(403);
    expect((await t.http.get('/v1/competitions').set(frontDesk.header)).status).toBe(200);
    const list = await t.http
      .get('/v1/competitions')
      .set(customer.header)
      .query({ sportFormat: 'futsal' });
    expect(list.status).toBe(200);
    expect(list.body.map((c: { name: string }) => c.name)).toContain('Monday Futsal');
  });

  it('SPK-COMP-002: rule sets are validated per format; posting a name again creates the next immutable version', async () => {
    const content = proposedRuleSetContent('futsal');
    const v1 = await t.http
      .post('/v1/rule-sets')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ name: 'Futsal house rules', format: 'futsal', content });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({
      name: 'Futsal house rules',
      format: 'futsal',
      version: 1,
      supersedesRuleSetId: null,
    });
    expect(v1.body.content.futsal).toEqual(content.futsal);
    expect(v1.body.content.outdoor).toBeNull();

    const wrongSection = await t.http
      .post('/v1/rule-sets')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        name: 'Bad futsal',
        format: 'futsal',
        content: { ...content, outdoor: { offside: true, throwIns: true } },
      });
    expect(wrongSection.status).toBe(400);
    expect(wrongSection.body.code).toBe('VALIDATION_FAILED');
    expect(wrongSection.body.details.map((d: { path: string }) => d.path)).toContain(
      'content.outdoor',
    );

    const v2 = await t.http
      .post('/v1/rule-sets')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        name: 'Futsal house rules',
        format: 'futsal',
        content: { ...content, protestDeadlineHours: 24 },
        reason: 'shorter protest window',
      });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, supersedesRuleSetId: v1.body.id });
    expect(v2.body.content.protestDeadlineHours).toBe(24);

    const formatChange = await t.http
      .post('/v1/rule-sets')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        name: 'Futsal house rules',
        format: 'outdoor',
        content: proposedRuleSetContent('outdoor'),
      });
    expect(formatChange.status).toBe(400);

    const latest = await t.http
      .get('/v1/rule-sets')
      .set(frontDesk.header)
      .query({ name: 'Futsal house rules', latestOnly: 'true' });
    expect(latest.status).toBe(200);
    expect(latest.body.map((r: { version: number }) => r.version)).toEqual([2]);
    const all = await t.http
      .get('/v1/rule-sets')
      .set(customer.header)
      .query({ name: 'Futsal house rules' });
    expect(all.body.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect((await t.http.get(`/v1/rule-sets/${v1.body.id}`).set(customer.header)).status).toBe(200);
    // immutable in the database as well
    await expect(
      t.db
        .updateTable('rule_sets')
        .set({ content: json(content) })
        .where('id', '=', v1.body.id)
        .execute(),
    ).rejects.toSatisfy(isRestrictViolation);
    // front desk cannot author rules
    const denied = await t.http
      .post('/v1/rule-sets')
      .set(frontDesk.header)
      .set('Idempotency-Key', key())
      .send({ name: 'Nope', format: 'futsal', content });
    expect(denied.status).toBe(403);
  });

  it('SPK-COMP-001: a season adopts one rule-set version of its competition format and moves through its lifecycle with revision guards', async () => {
    const competition = await t.http
      .post('/v1/competitions')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ name: 'Winter Futsal', kind: 'league', sportFormat: 'futsal' });
    const futsalRules = (
      await t.http
        .get('/v1/rule-sets')
        .set(leagueManager.header)
        .query({ name: 'Futsal house rules', latestOnly: 'true' })
    ).body[0];
    const outdoorRules = await t.http
      .post('/v1/rule-sets')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        name: 'Outdoor rules',
        format: 'outdoor',
        content: proposedRuleSetContent('outdoor'),
      });

    const mismatch = await t.http
      .post('/v1/seasons')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        competitionId: competition.body.id,
        name: 'Winter 2027',
        ruleSetId: outdoorRules.body.id,
        startsOn: '2027-01-10',
        endsOn: '2027-04-10',
      });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('VALIDATION_FAILED');

    const season = await t.http
      .post('/v1/seasons')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        competitionId: competition.body.id,
        name: 'Winter 2027',
        ruleSetId: futsalRules.id,
        startsOn: '2027-01-10',
        endsOn: '2027-04-10',
        registrationOfferingRef: 'offering:winter-2027',
        registrationOpensAt: '2026-11-01T08:00:00.000Z',
        registrationClosesAt: '2026-12-20T08:00:00.000Z',
      });
    expect(season.status).toBe(201);
    expect(season.body).toMatchObject({
      status: 'draft',
      ruleSetId: futsalRules.id,
      startsOn: '2027-01-10',
      endsOn: '2027-04-10',
      registrationOfferingRef: 'offering:winter-2027',
      revision: 1,
    });
    const id = season.body.id as string;
    const patch = (body: Record<string, unknown>, actor: Actor = leagueManager) =>
      t.http.patch(`/v1/seasons/${id}`).set(actor.header).set('Idempotency-Key', key()).send(body);

    const opened = await patch({ status: 'open', expectedRevision: 1 });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ status: 'open', revision: 2 });
    const stale = await patch({ status: 'active', expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const skip = await patch({ status: 'completed', expectedRevision: 2 });
    expect(skip.status).toBe(409);
    expect(skip.body.code).toBe('INVALID_TRANSITION');
    const ruleChange = await patch({ ruleSetId: outdoorRules.body.id, expectedRevision: 2 });
    expect(ruleChange.status).toBe(409);
    expect(ruleChange.body.code).toBe('INVALID_TRANSITION');
    expect((await patch({ status: 'active', expectedRevision: 2 })).body.status).toBe('active');
    expect((await patch({ status: 'completed', expectedRevision: 3 })).body.status).toBe(
      'completed',
    );
    expect((await patch({ status: 'archived', expectedRevision: 4 })).body.status).toBe('archived');
    const reopen = await patch({ status: 'open', expectedRevision: 5 });
    expect(reopen.status).toBe(409);
    const denied = await patch({ name: 'Renamed', expectedRevision: 5 }, frontDesk);
    expect(denied.status).toBe(403);
    const events = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('aggregate_id', '=', id)
      .where('event_type', '=', 'competition.season_updated')
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => (e.payload as { status: string }).status)).toEqual([
      'open',
      'active',
      'completed',
      'archived',
    ]);
    const listed = await t.http
      .get('/v1/seasons')
      .set(customer.header)
      .query({ competitionId: competition.body.id });
    expect(listed.status).toBe(200);
    expect(listed.body.map((s: { id: string }) => s.id)).toEqual([id]);
  });

  it('SPK-COMP-003 / DEC-048: divisions carry documented criteria and a capacity that cannot drop below the placed entries', async () => {
    const season = await createSeasonFixture(t);
    const created = await t.http
      .post('/v1/divisions')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        name: 'Over 30 B',
        criteria: {
          ageBand: { minAge: 30, maxAge: null },
          level: 'B',
          category: 'adult_open',
          format: '7v7',
        },
        facilityId: t.facilityId,
        capacityTeamEntries: 2,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      seasonId: season.seasonId,
      name: 'Over 30 B',
      criteria: {
        ageBand: { minAge: 30, maxAge: null },
        level: 'B',
        category: 'adult_open',
        format: '7v7',
      },
      facilityId: t.facilityId,
      capacityTeamEntries: 2,
      entryCount: 0,
      revision: 1,
    });
    const duplicate = await t.http
      .post('/v1/divisions')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ seasonId: season.seasonId, name: 'Over 30 B' });
    expect(duplicate.status).toBe(409);
    const badBand = await t.http
      .post('/v1/divisions')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        name: 'Inverted',
        criteria: { ageBand: { minAge: 40, maxAge: 30 } },
      });
    expect(badBand.status).toBe(400);

    const divisionId = created.body.id as string;
    for (let i = 0; i < 2; i += 1) {
      const captain = await createPersonFixture(t, { kind: 'adult' });
      await createTeamEntryFixture(t, {
        seasonId: season.seasonId,
        captainPersonId: captain,
        divisionId,
      });
    }
    const shrink = await t.http
      .patch(`/v1/divisions/${divisionId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ capacityTeamEntries: 1, expectedRevision: 1 });
    expect(shrink.status).toBe(400);
    expect(shrink.body.details).toMatchObject({ occupied: 2, capacity: 1 });
    const grow = await t.http
      .patch(`/v1/divisions/${divisionId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ capacityTeamEntries: 3, criteria: { level: 'B+' }, expectedRevision: 1 });
    expect(grow.status).toBe(200);
    expect(grow.body).toMatchObject({
      capacityTeamEntries: 3,
      entryCount: 2,
      revision: 2,
      criteria: { level: 'B+', ageBand: null },
    });
    const listed = await t.http
      .get('/v1/divisions')
      .set(customer.header)
      .query({ seasonId: season.seasonId });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(
      (await t.http.get(`/v1/divisions/${divisionId}`).set(frontDesk.header)).body.entryCount,
    ).toBe(2);
  });

  it('§4.3 / §4.10: records of another organization are not found, even for a league manager there', async () => {
    const other = await seedOrganization(t.db);
    const otherManager = await staffMember(t, ['league_manager'], other.organizationId);
    const competitionId = await createCompetitionFixture(t);
    const season = await createSeasonFixture(t, { competitionId });
    const division = await createDivisionFixture(t, { seasonId: season.seasonId });
    expect(
      (await t.http.get(`/v1/competitions/${competitionId}`).set(otherManager.header)).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/v1/seasons/${season.seasonId}`).set(otherManager.header)).status,
    ).toBe(404);
    expect((await t.http.get(`/v1/divisions/${division}`).set(otherManager.header)).status).toBe(
      404,
    );
    expect(
      (await t.http.get(`/v1/rule-sets/${season.ruleSetId}`).set(otherManager.header)).status,
    ).toBe(404);
    const patched = await t.http
      .patch(`/v1/seasons/${season.seasonId}`)
      .set(otherManager.header)
      .set('Idempotency-Key', key())
      .send({ name: 'Hijack', expectedRevision: 1 });
    expect(patched.status).toBe(404);
    const foreignSeason = await t.http
      .post('/v1/seasons')
      .set(otherManager.header)
      .set('Idempotency-Key', key())
      .send({
        competitionId,
        name: 'Cross org',
        ruleSetId: season.ruleSetId,
        startsOn: '2027-01-10',
        endsOn: '2027-04-10',
      });
    expect(foreignSeason.status).toBe(404);
    const list = await t.http.get('/v1/competitions').set(otherManager.header);
    expect(list.body.map((c: { id: string }) => c.id)).not.toContain(competitionId);
  });
});
