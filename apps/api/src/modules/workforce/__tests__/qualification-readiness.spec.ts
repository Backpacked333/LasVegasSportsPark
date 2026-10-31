import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Trx } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import { AssignmentsService } from '../services/assignments.service';
import { CoverageService } from '../services/coverage.service';
import { QualificationsService } from '../services/qualifications.service';
import { RequirementsService } from '../services/requirements.service';
import { createQualificationFixture } from '../testing/workforce-fixtures';
import {
  backendPid,
  competitionWorld,
  drainOutbox,
  gate,
  key,
  post,
  scheduleFixture,
  staffMember,
  tracked,
  untilSettledOrWaiting,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

interface ReadinessIssue {
  code: string;
  severity: string;
  message: string;
  source: { type: string; id: string };
}

/**
 * Readiness is derived from the authoritative records at read time (SPK-READY-002/004,
 * SPK-STAFF-001): an accepted official counts only while they hold the requirement's
 * qualifications, verified and valid at the game's current start. A lapse after acceptance (a
 * revocation, a requirement edited to add a qualification, a reschedule past the validity) blocks
 * the check and is raised for an operator; nothing is withdrawn automatically (POL-033 pending).
 */
describe('required officials stay qualified after acceptance (SPK-READY-004, SPK-STAFF-001)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let lm: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    lm = world.leagueManager;
  });
  afterAll(async () => {
    await t.close();
  });

  async function readiness(fixtureId: string) {
    const res = await t.http.get(`/v1/fixtures/${fixtureId}/readiness`).set(lm.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {
      check: (res.body.checks as Array<{ name: string; status: string }>).find(
        (c) => c.name === 'workforce.required_officials',
      ),
      issues: (res.body.issues as ReadinessIssue[]).filter(
        (i) => i.source?.type === 'assignment_requirement',
      ),
    };
  }

  async function requirement(fixtureId: string, qualifications: string[]) {
    const req = await post(t, '/v1/assignment-requirements', lm, {
      targetType: 'fixture',
      targetId: fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
      requiredQualifications: qualifications,
    });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    return req.body as { id: string; revision: number };
  }

  async function offeredReferee(fixtureId: string, official: Actor): Promise<string> {
    const offered = await post(t, '/v1/assignments', lm, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role: 'referee',
      offer: true,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    return offered.body.assignment.id as string;
  }

  async function acceptedReferee(fixtureId: string, official: Actor): Promise<string> {
    const id = await offeredReferee(fixtureId, official);
    const accepted = await post(t, `/v1/assignments/${id}/accept`, official, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return id;
  }

  const unqualifiedExceptions = (assignmentId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'owner_queue', 'severity'])
      .where('category', '=', 'workforce.unqualified_assignment')
      .where('affected_id', '=', assignmentId)
      .execute();

  it('SPK-READY-004 / SPK-STAFF-001: a qualification revoked after acceptance blocks the officials check and is raised for the league manager', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-10' });
    const req = await requirement(game.fixtureId, ['referee_grade_7']);
    const qualificationId = await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
    });
    const assignment = await acceptedReferee(game.fixtureId, official);
    expect((await readiness(game.fixtureId)).check?.status).toBe('ready');
    const revoked = await post(t, `/v1/qualifications/${qualificationId}/revoke`, lm, {
      reason: 'Licence suspended',
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    await drainOutbox(t);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    const issue = after.issues.find((i) => i.code === 'required_official_unqualified');
    expect(issue).toMatchObject({
      severity: 'blocking',
      source: { type: 'assignment_requirement', id: req.id },
    });
    // the message reaches team members: it names neither the person nor their record's status
    expect(issue?.message).not.toContain(official.personId);
    expect(issue?.message).not.toMatch(/revoked|expired|unverified/);
    // the assignment fact stays; an operator decides (POL-033 pending)
    const row = await t.http.get(`/v1/assignments/${assignment}`).set(lm.header);
    expect(row.body.status).toBe('accepted');
    expect(await unqualifiedExceptions(assignment)).toEqual([
      { status: 'open', owner_queue: 'league_manager', severity: 'high' },
    ]);
  });

  /**
   * TEST_DATABASE_URL: the backend pid of the transaction that calls `method` with matching
   * arguments (its first argument is the transaction), recorded before the call can wait for a lock.
   */
  function lockingReads<T extends object>(
    target: T,
    method: string,
    matches: (args: unknown[]) => boolean,
  ) {
    const pids: number[] = [];
    const host = target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = host[method]!.bind(target);
    const spy = vi.spyOn(host, method).mockImplementation(async (...args: unknown[]) => {
      if (t.database.concurrent && matches(args)) {
        const pid = await backendPid(args[0] as Trx);
        if (pid !== undefined) pids.push(pid);
      }
      return original(...args);
    });
    return { pids, restore: () => spy.mockRestore() };
  }

  it('SPK-READY-004: a requirement edited to add a qualification the accepted official lacks blocks the check', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-11' });
    const req = await requirement(game.fixtureId, []);
    const assignment = await acceptedReferee(game.fixtureId, official);
    expect((await readiness(game.fixtureId)).check?.status).toBe('ready');
    const patched = await t.http
      .patch(`/v1/assignment-requirements/${req.id}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ requiredQualifications: ['referee_grade_7'], expectedRevision: req.revision });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    expect(after.issues.map((i) => i.code)).toContain('required_official_unqualified');
    expect(await unqualifiedExceptions(assignment)).toHaveLength(1);
  });

  it('SPK-READY-004: a reschedule past the qualification’s validity blocks the check', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-12' });
    await requirement(game.fixtureId, ['referee_grade_7']);
    await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
      validTo: new Date(at('2027-02-13', '00:00')),
    });
    await acceptedReferee(game.fixtureId, official);
    expect((await readiness(game.fixtureId)).check?.status).toBe('ready');
    const fixture = await t.http.get(`/v1/fixtures/${game.fixtureId}`).set(lm.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${game.fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: fixture.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [world.pitch.pitchId],
          scheduledStart: at('2027-02-20', '18:00'),
          scheduledEnd: at('2027-02-20', '19:00'),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    expect(after.issues.map((i) => i.code)).toContain('required_official_unqualified');
  });

  it('SPK-READY-004: a qualified acceptance keeps the check ready and raises nothing', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-14' });
    await requirement(game.fixtureId, ['referee_grade_7']);
    await createQualificationFixture(t, { personId: official.personId, kind: 'referee_grade_7' });
    // a second, still valid qualification of the same kind keeps them qualified after a revocation
    const spare = await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
    });
    const assignment = await acceptedReferee(game.fixtureId, official);
    expect(
      (await post(t, `/v1/qualifications/${spare}/revoke`, lm, { reason: 'Duplicate record' }))
        .status,
    ).toBe(200);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('ready');
    expect(await unqualifiedExceptions(assignment)).toEqual([]);
  });

  /**
   * R2-RACES-02: an acceptance and a revocation of the qualification it depends on, overlapping.
   * A gate pauses one command inside its open transaction while the other one is sent. Under
   * TEST_DATABASE_URL the two transactions really overlap: the paused one holds the person's party
   * lock, the other waits for it and then reads what the first committed. Under PGlite the second
   * runs once the first commits. Either way the outcome is the one a sequential execution gives:
   * the acceptance is refused, or it commits and the revocation raises the exception. (Requirement
   * edits and creations overlapping a revocation or an acceptance are the next block.)
   */
  describe('acceptance and revocation under concurrency (SPK-STAFF-001, SPK-READY-004)', () => {
    it('R2-RACES-02 / SPK-STAFF-001: a revocation sent while the acceptance is open raises the unqualified assignment (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-16' });
      await requirement(game.fixtureId, ['referee_grade_5']);
      const qualificationId = await createQualificationFixture(t, {
        personId: official.personId,
        kind: 'referee_grade_5',
      });
      const assignment = await offeredReferee(game.fixtureId, official);
      const qualifications = t.app.get(QualificationsService);
      const check = qualifications.check.bind(qualifications);
      const afterRead = gate();
      let armed = true;
      const checkSpy = vi
        .spyOn(qualifications, 'check')
        .mockImplementation(async (db, organizationId, personId, kinds, instant) => {
          const result = await check(db, organizationId, personId, kinds, instant);
          // the acceptance has read the qualification as verified, inside its open transaction
          if (armed && personId === official.personId) {
            armed = false;
            await afterRead.pass();
          }
          return result;
        });
      const revoker = lockingReads(
        qualifications,
        'load',
        (args) => args[2] === qualificationId && args[3] === true,
      );
      try {
        const accepting = tracked(post(t, `/v1/assignments/${assignment}/accept`, official, {}));
        await afterRead.reached;
        const revoking = tracked(
          post(t, `/v1/qualifications/${qualificationId}/revoke`, lm, {
            reason: 'Licence suspended',
          }),
        );
        // PostgreSQL: the revocation waits for the person's lock the acceptance holds (without it,
        // it would commit beside the paused acceptance and find nothing to raise).
        if (t.database.concurrent) {
          await untilSettledOrWaiting(t, revoking, () => revoker.pids[0]);
        }
        afterRead.open();
        const [accepted, revoked] = await Promise.all([accepting.promise, revoking.promise]);
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      } finally {
        checkSpy.mockRestore();
        revoker.restore();
      }
      expect(await unqualifiedExceptions(assignment)).toEqual([
        { status: 'open', owner_queue: 'league_manager', severity: 'high' },
      ]);
    });

    it('R2-RACES-02 / SPK-STAFF-001: an acceptance sent while the revocation is open is refused (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-17' });
      await requirement(game.fixtureId, ['referee_grade_5']);
      const qualificationId = await createQualificationFixture(t, {
        personId: official.personId,
        kind: 'referee_grade_5',
      });
      const assignment = await offeredReferee(game.fixtureId, official);
      const qualifications = t.app.get(QualificationsService);
      const flag = qualifications.flagUnqualifiedAssignments.bind(qualifications);
      const afterFlag = gate();
      const flagSpy = vi
        .spyOn(qualifications, 'flagUnqualifiedAssignments')
        .mockImplementation(async (trx, organizationId, scope) => {
          const raised = await flag(trx, organizationId, scope);
          // the revocation is written and has looked for accepted assignments; it is not committed
          if ('personId' in scope && scope.personId === official.personId) await afterFlag.pass();
          return raised;
        });
      const acceptor = lockingReads(
        t.app.get(AssignmentsService),
        'lock',
        (args) => args[2] === assignment,
      );
      try {
        const revoking = tracked(
          post(t, `/v1/qualifications/${qualificationId}/revoke`, lm, {
            reason: 'Licence suspended',
          }),
        );
        await afterFlag.reached;
        const accepting = tracked(post(t, `/v1/assignments/${assignment}/accept`, official, {}));
        // PostgreSQL: the acceptance waits for the person's lock the revocation holds (without it,
        // it would read the still-verified qualification and commit beside the paused revocation).
        if (t.database.concurrent) {
          await untilSettledOrWaiting(t, accepting, () => acceptor.pids[0]);
        }
        afterFlag.open();
        const [revoked, accepted] = await Promise.all([revoking.promise, accepting.promise]);
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(422);
        expect(accepted.body.details.reasons).toEqual([
          expect.objectContaining({ code: 'qualification_missing', kind: 'referee_grade_5' }),
        ]);
      } finally {
        flagSpy.mockRestore();
        acceptor.restore();
      }
      const row = await t.http.get(`/v1/assignments/${assignment}`).set(lm.header);
      expect(row.body.status).toBe('offered');
      expect(await unqualifiedExceptions(assignment)).toEqual([]);
    });
  });

  /**
   * R2-RACES-02, the requirement side: a requirement edit or creation that adds a qualification,
   * overlapping a revocation of that qualification or an acceptance by someone who lacks it. A gate
   * pauses one command inside its open transaction while the other one is sent. Under
   * TEST_DATABASE_URL the second command waits for the requirement lock the first one holds (the
   * requirement row for an edit, the requirement key for a creation) and then reads what the first
   * committed; under PGlite it runs once the first commits. Either way the outcome is the one a
   * sequential execution gives: an accepted assignment whose requirement names a qualification the
   * assignee does not hold always has its `workforce.unqualified_assignment` exception.
   */
  describe('requirement changes under concurrency (SPK-STAFF-001, SPK-READY-004)', () => {
    const kind = 'referee_grade_4';
    const pending: Array<{ restore: () => void }> = [];
    afterEach(() => {
      for (const spy of pending.splice(0)) spy.restore();
    });

    function patchRequirement(req: { id: string; revision: number }, body: object) {
      return t.http
        .patch(`/v1/assignment-requirements/${req.id}`)
        .set(lm.header)
        .set('Idempotency-Key', key())
        .send({ ...body, expectedRevision: req.revision });
    }

    function createRequirement(fixtureId: string, qualifications: string[]) {
      return post(t, '/v1/assignment-requirements', lm, {
        targetType: 'fixture',
        targetId: fixtureId,
        kind: 'official',
        role: 'referee',
        requiredCount: 1,
        requiredQualifications: qualifications,
      });
    }

    const revoke = (qualificationId: string) =>
      post(t, `/v1/qualifications/${qualificationId}/revoke`, lm, { reason: 'Licence suspended' });

    /** Pauses the first flagUnqualifiedAssignments call matching `scope`, after it has run. */
    function pauseAfterFlag(matches: (scope: Record<string, unknown>) => boolean) {
      const qualifications = t.app.get(QualificationsService);
      const flag = qualifications.flagUnqualifiedAssignments.bind(qualifications);
      const paused = gate();
      let armed = true;
      const spy = vi
        .spyOn(qualifications, 'flagUnqualifiedAssignments')
        .mockImplementation(async (trx, organizationId, scope) => {
          const raised = await flag(trx, organizationId, scope);
          if (armed && matches(scope)) {
            armed = false;
            await paused.pass();
          }
          return raised;
        });
      pending.push({ restore: () => spy.mockRestore() });
      return paused;
    }

    /** The revocation's backend pid (its qualification row lock is its first locking read). */
    const revoker = (qualificationId: string) => {
      const spy = lockingReads(
        t.app.get(QualificationsService),
        'load',
        (args) => args[2] === qualificationId && args[3] === true,
      );
      pending.push(spy);
      return spy;
    };

    async function overlap<A, B>(
      first: () => PromiseLike<A>,
      paused: ReturnType<typeof gate>,
      second: () => PromiseLike<B>,
      waiter: { pids: number[] },
    ): Promise<[A, B]> {
      const one = tracked(first());
      await paused.reached;
      const two = tracked(second());
      // PostgreSQL: the second command waits for the lock the paused one holds (without it, it
      // would commit beside the paused command and neither would raise the exception).
      if (t.database.concurrent) await untilSettledOrWaiting(t, two, () => waiter.pids[0]);
      paused.open();
      return Promise.all([one.promise, two.promise]);
    }

    it('R2-RACES-02 / SPK-STAFF-001: a revocation sent while a requirement edit adding its qualification is open raises the unqualified assignment (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-18' });
      const req = await requirement(game.fixtureId, []);
      const qualificationId = await createQualificationFixture(t, {
        personId: official.personId,
        kind,
      });
      const assignment = await acceptedReferee(game.fixtureId, official);
      const paused = pauseAfterFlag((scope) => scope.targetId === game.fixtureId);
      const [edited, revoked] = await overlap(
        () => patchRequirement(req, { requiredQualifications: [kind] }),
        paused,
        () => revoke(qualificationId),
        revoker(qualificationId),
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(await unqualifiedExceptions(assignment)).toEqual([
        { status: 'open', owner_queue: 'league_manager', severity: 'high' },
      ]);
    });

    it('R2-RACES-02 / SPK-STAFF-001: a requirement edit adding a qualification, sent while its revocation is open, raises the unqualified assignment (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-19' });
      const req = await requirement(game.fixtureId, []);
      const qualificationId = await createQualificationFixture(t, {
        personId: official.personId,
        kind,
      });
      const assignment = await acceptedReferee(game.fixtureId, official);
      const paused = pauseAfterFlag((scope) => scope.personId === official.personId);
      const editor = lockingReads(
        t.app.get(RequirementsService),
        'load',
        (args) => args[2] === req.id && args[3] === true,
      );
      pending.push(editor);
      const [revoked, edited] = await overlap(
        () => revoke(qualificationId),
        paused,
        () => patchRequirement(req, { requiredQualifications: [kind] }),
        editor,
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(await unqualifiedExceptions(assignment)).toEqual([
        { status: 'open', owner_queue: 'league_manager', severity: 'high' },
      ]);
    });

    it('R2-RACES-02 / SPK-STAFF-001: a revocation sent while a requirement creation naming its qualification is open raises the unqualified assignment (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-22' });
      const qualificationId = await createQualificationFixture(t, {
        personId: official.personId,
        kind,
      });
      // accepted before the target had any requirement
      const assignment = await acceptedReferee(game.fixtureId, official);
      const paused = pauseAfterFlag((scope) => scope.targetId === game.fixtureId);
      const [created, revoked] = await overlap(
        () => createRequirement(game.fixtureId, [kind]),
        paused,
        () => revoke(qualificationId),
        revoker(qualificationId),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(await unqualifiedExceptions(assignment)).toEqual([
        { status: 'open', owner_queue: 'league_manager', severity: 'high' },
      ]);
    });

    it('R2-RACES-02 / SPK-STAFF-001: a requirement creation sent while its qualification’s revocation is open raises the unqualified assignment (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-23' });
      const qualificationId = await createQualificationFixture(t, {
        personId: official.personId,
        kind,
      });
      const assignment = await acceptedReferee(game.fixtureId, official);
      const paused = pauseAfterFlag((scope) => scope.personId === official.personId);
      const creator = lockingReads(
        t.app.get(CoverageService),
        'lockRequirementKey',
        (args) => args[3] === game.fixtureId,
      );
      pending.push(creator);
      const [revoked, created] = await overlap(
        () => revoke(qualificationId),
        paused,
        () => createRequirement(game.fixtureId, [kind]),
        creator,
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(await unqualifiedExceptions(assignment)).toEqual([
        { status: 'open', owner_queue: 'league_manager', severity: 'high' },
      ]);
    });

    it('R2-RACES-02 / SPK-STAFF-001: an acceptance sent while a requirement creation naming a qualification the assignee lacks is open is refused (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-24' });
      const assignment = await offeredReferee(game.fixtureId, official);
      const paused = pauseAfterFlag((scope) => scope.targetId === game.fixtureId);
      const acceptor = lockingReads(
        t.app.get(CoverageService),
        'lockRequirementShared',
        (args) => args[3] === game.fixtureId,
      );
      pending.push(acceptor);
      const [created, accepted] = await overlap(
        () => createRequirement(game.fixtureId, [kind]),
        paused,
        () => post(t, `/v1/assignments/${assignment}/accept`, official, {}),
        acceptor,
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(422);
      expect(accepted.body.details.reasons).toEqual([
        expect.objectContaining({ code: 'qualification_missing', kind }),
      ]);
      const row = await t.http.get(`/v1/assignments/${assignment}`).set(lm.header);
      expect(row.body.status).toBe('offered');
      expect(await unqualifiedExceptions(assignment)).toEqual([]);
    });

    it('R2-RACES-02 / SPK-STAFF-001: a requirement creation sent while an acceptance by someone lacking its qualification is open raises the unqualified assignment (PGlite and TEST_DATABASE_URL)', async () => {
      const official = await staffMember(t, ['official']);
      const game = await scheduleFixture(t, world, { date: '2027-02-25' });
      const assignment = await offeredReferee(game.fixtureId, official);
      const assignments = t.app.get(AssignmentsService);
      const assertAssignable = assignments.assertAssignable.bind(assignments);
      const paused = gate();
      const assignableSpy = vi
        .spyOn(assignments, 'assertAssignable')
        .mockImplementation(async (trx, input) => {
          await assertAssignable(trx, input);
          // the acceptance found no requirement and holds its locks, inside its open transaction
          if (input.personId === official.personId) await paused.pass();
        });
      pending.push({ restore: () => assignableSpy.mockRestore() });
      const creator = lockingReads(
        t.app.get(CoverageService),
        'lockRequirementKey',
        (args) => args[3] === game.fixtureId,
      );
      pending.push(creator);
      const [accepted, created] = await overlap(
        () => post(t, `/v1/assignments/${assignment}/accept`, official, {}),
        paused,
        () => createRequirement(game.fixtureId, [kind]),
        creator,
      );
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(await unqualifiedExceptions(assignment)).toEqual([
        { status: 'open', owner_queue: 'league_manager', severity: 'high' },
      ]);
    });
  });

  it('SPK-STAFF-001 / SPK-READY-004: a requirement created with a qualification an accepted official lacks raises the unqualified assignment', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, { date: '2027-02-26' });
    const assignment = await acceptedReferee(game.fixtureId, official);
    await requirement(game.fixtureId, ['referee_grade_3']);
    const after = await readiness(game.fixtureId);
    expect(after.check?.status).toBe('blocked');
    expect(after.issues.map((i) => i.code)).toContain('required_official_unqualified');
    expect(await unqualifiedExceptions(assignment)).toEqual([
      { status: 'open', owner_queue: 'league_manager', severity: 'high' },
    ]);
  });

  it('SPK-STAFF-001: raising the required count brings an accepted slot whose qualification lapsed meanwhile under the requirement, and raises it', async () => {
    const [first, second] = [
      await staffMember(t, ['official']),
      await staffMember(t, ['official']),
    ];
    const game = await scheduleFixture(t, world, { date: '2027-03-01' });
    const create = await post(t, '/v1/assignment-requirements', lm, {
      targetType: 'fixture',
      targetId: game.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 2,
      requiredQualifications: ['referee_grade_2'],
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    await createQualificationFixture(t, { personId: first.personId, kind: 'referee_grade_2' });
    const lapsing = await createQualificationFixture(t, {
      personId: second.personId,
      kind: 'referee_grade_2',
    });
    await acceptedReferee(game.fixtureId, first);
    const slotTwo = await acceptedReferee(game.fixtureId, second);
    const lowered = await t.http
      .patch(`/v1/assignment-requirements/${create.body.id}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ requiredCount: 1, expectedRevision: create.body.revision });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    // slot 2 is no longer required, so its lapse is not an exception yet
    expect(
      (await post(t, `/v1/qualifications/${lapsing}/revoke`, lm, { reason: 'Lapsed' })).status,
    ).toBe(200);
    expect(await unqualifiedExceptions(slotTwo)).toEqual([]);
    const raised = await t.http
      .patch(`/v1/assignment-requirements/${create.body.id}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ requiredCount: 2, expectedRevision: lowered.body.revision });
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    expect(await unqualifiedExceptions(slotTwo)).toEqual([
      { status: 'open', owner_queue: 'league_manager', severity: 'high' },
    ]);
  });
});
