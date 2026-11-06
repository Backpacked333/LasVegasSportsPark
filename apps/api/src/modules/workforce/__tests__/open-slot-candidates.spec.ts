import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createAssignmentFixture, createQualificationFixture } from '../testing/workforce-fixtures';
import {
  adultCustomer,
  competitionWorld,
  CONFIGURED_POLICY_ENV,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

interface Candidate {
  personId: string;
  eligible: boolean;
  grade: string | null;
  safeguarding: { kind: string; status: string; validTo: string | null } | null;
  reasons: Array<{ code: string; severity: string }>;
}

/**
 * Open-slot candidates (SPK-STAFF-003, SPK-AT-012), the official grade and safeguarding
 * certification in candidate reasons (SPK-STAFF-001), and the staff assigned to an activity
 * (SPK-STAFF-002) for the arrival screen.
 */
describe('open-slot candidates, grade and safeguarding, assigned staff (SPK-STAFF-001/002/003)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let leagueManager: Actor;
  let frontDesk: Actor;
  let game: ScheduledFixture;
  let graded: Actor;
  let lapsed: Actor;
  let onRole: Actor;
  let requirementId: string;

  beforeAll(async () => {
    t = await workforceTestApp({
      settings: {
        ...CONFIGURED_POLICY_ENV,
        WORKFORCE_OFFICIAL_GRADE_QUALIFICATION_KIND: 'referee_grade',
        WORKFORCE_SAFEGUARDING_QUALIFICATION_KIND: 'safeguarding',
      },
    });
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    frontDesk = await staffMember(t, ['front_desk']);
    game = await scheduleFixture(t, world, { date: '2027-01-20' });
    graded = await staffMember(t, ['official']);
    lapsed = await staffMember(t, ['official']);
    onRole = await staffMember(t, ['official']);
    await createQualificationFixture(t, {
      personId: graded.personId,
      kind: 'referee_grade',
      level: '8',
    });
    await createQualificationFixture(t, {
      personId: graded.personId,
      kind: 'safeguarding',
      validTo: new Date('2027-06-30T00:00:00Z'),
    });
    // Expired before the game.
    await createQualificationFixture(t, {
      personId: lapsed.personId,
      kind: 'safeguarding',
      validFrom: new Date('2025-01-01T00:00:00Z'),
      validTo: new Date('2026-12-31T00:00:00Z'),
    });
    const requirement = await post(t, '/v1/assignment-requirements', leagueManager, {
      targetType: 'fixture',
      targetId: game.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 2,
    });
    expect(requirement.status, JSON.stringify(requirement.body)).toBe(201);
    requirementId = requirement.body.id as string;
    await createAssignmentFixture(t, {
      personId: onRole.personId,
      targetType: 'fixture',
      targetId: game.fixtureId,
      scheduledStart: game.start,
      scheduledEnd: game.end,
      status: 'accepted',
      role: 'referee',
      kind: 'official',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-STAFF-003: an open slot with no assignment to replace gets ranked candidates; someone already on the role is blocked', async () => {
    const res = await t.http
      .get(`/v1/assignment-requirements/${requirementId}/candidates`)
      .set(leagueManager.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      requirementId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
      requiredCount: 2,
      covered: 1,
      scheduledStart: game.start,
    });
    const candidates = res.body.candidates as Candidate[];
    const byId = new Map(candidates.map((c) => [c.personId, c]));
    expect(byId.get(onRole.personId)).toMatchObject({ eligible: false });
    expect(byId.get(onRole.personId)!.reasons.map((r) => r.code)).toContain('already_on_role');
    expect(byId.get(graded.personId)!.eligible).toBe(true);
    // The eligible candidates rank first.
    expect(candidates[candidates.length - 1]!.personId).toBe(onRole.personId);
  });

  it('SPK-STAFF-001: candidate reasons name the official grade and the safeguarding certification with its expiry', async () => {
    const res = await t.http
      .get(`/v1/assignment-requirements/${requirementId}/candidates`)
      .set(leagueManager.header);
    const byId = new Map((res.body.candidates as Candidate[]).map((c) => [c.personId, c]));
    const g = byId.get(graded.personId)!;
    expect(g.grade).toBe('8');
    expect(g.safeguarding).toEqual({
      kind: 'safeguarding',
      status: 'held',
      validTo: '2027-06-30T00:00:00.000Z',
    });
    expect(g.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'official_grade', severity: 'info' }),
        expect.objectContaining({ code: 'safeguarding_current', severity: 'positive' }),
      ]),
    );
    const l = byId.get(lapsed.personId)!;
    expect(l.grade).toBeNull();
    expect(l.safeguarding).toMatchObject({ status: 'expired' });
    expect(l.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'safeguarding_expired', severity: 'warning' }),
        expect.objectContaining({ code: 'official_grade_unknown', severity: 'info' }),
      ]),
    );
    // A warning, not a block: the requirement names no safeguarding qualification.
    expect(l.eligible).toBe(true);
  });

  it('SPK-STAFF-001: without configured kinds candidates name no grade or safeguarding status', async () => {
    const plain = await workforceTestApp();
    try {
      const w = await competitionWorld(plain);
      const g = await scheduleFixture(plain, w, { date: '2027-01-20' });
      await staffMember(plain, ['official']);
      const req = await post(plain, '/v1/assignment-requirements', w.leagueManager, {
        targetType: 'fixture',
        targetId: g.fixtureId,
        kind: 'official',
        role: 'referee',
        requiredCount: 1,
      });
      const res = await plain.http
        .get(`/v1/assignment-requirements/${req.body.id}/candidates`)
        .set(w.leagueManager.header);
      expect(res.status).toBe(200);
      for (const c of res.body.candidates as Candidate[]) {
        expect(c.grade).toBeNull();
        expect(c.safeguarding).toBeNull();
        expect(c.reasons.map((r) => r.code)).not.toContain('official_grade_unknown');
      }
    } finally {
      await plain.close();
    }
  });

  it('SPK-STAFF-003: a customer may not read open-slot candidates; an unknown requirement is NOT_FOUND', async () => {
    const customer = await adultCustomer(t);
    const refused = await t.http
      .get(`/v1/assignment-requirements/${requirementId}/candidates`)
      .set(customer.header);
    expect(refused.status).toBe(403);
    const unknown = await t.http
      .get(`/v1/assignment-requirements/${game.fixtureId}/candidates`)
      .set(leagueManager.header);
    expect(unknown.status).toBe(404);
  });

  it('SPK-STAFF-002: assigned staff lists accepted assignments only, per activity', async () => {
    await createAssignmentFixture(t, {
      personId: graded.personId,
      targetType: 'fixture',
      targetId: game.fixtureId,
      scheduledStart: game.start,
      scheduledEnd: game.end,
      status: 'offered',
      role: 'referee',
      kind: 'official',
      slot: 2,
    });
    const res = await t.http
      .get(`/v1/assigned-staff?targetType=fixture&targetIds=${game.fixtureId}`)
      .set(frontDesk.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].targetId).toBe(game.fixtureId);
    expect(res.body.items[0].staff).toEqual([
      expect.objectContaining({
        personId: onRole.personId,
        kind: 'official',
        role: 'referee',
        status: 'accepted',
      }),
    ]);
    const customer = await adultCustomer(t);
    const refused = await t.http
      .get(`/v1/assigned-staff?targetType=fixture&targetIds=${game.fixtureId}`)
      .set(customer.header);
    expect(refused.status).toBe(403);
  });
});
