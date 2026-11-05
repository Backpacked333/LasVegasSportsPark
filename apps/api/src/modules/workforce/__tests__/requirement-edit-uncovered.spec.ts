import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperationalExceptions, type Trx } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { CoverageService } from '../services/coverage.service';
import { RequirementsService } from '../services/requirements.service';
import { createQualificationFixture } from '../testing/workforce-fixtures';
import { UNCOVERED_ASSIGNMENT, UNQUALIFIED_ASSIGNMENT } from '../workforce.policy';
import {
  backendPid,
  competitionWorld,
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

interface Requirement {
  id: string;
  revision: number;
}

/**
 * R4-OPS-MODULES-08 (SPK-UX-006 the exception queue reflects reality, SPK-STAFF-003 / SPK-AT-012
 * escalation): an edit after which a slot is no longer required (the count lowered below it, or
 * acceptance no longer demanded) resolves that slot's open `workforce.uncovered_assignment`
 * exception in the same transaction, naming the requirement's revision, as a retirement does
 * (WRK-02). Exceptions of slots still required stay open.
 */
describe('a requirement edit settles the uncovered slots it no longer requires (R4-OPS-MODULES-08)', () => {
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

  async function requirement(
    fixtureId: string,
    role: string,
    requiredCount: number,
  ): Promise<Requirement> {
    const res = await post(t, '/v1/assignment-requirements', lm, {
      targetType: 'fixture',
      targetId: fixtureId,
      kind: 'official',
      role,
      requiredCount,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as Requirement;
  }

  function patchRequirement(req: Requirement, body: object) {
    return t.http
      .patch(`/v1/assignment-requirements/${req.id}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ ...body, expectedRevision: req.revision });
  }

  async function accepted(
    fixtureId: string,
    role: string,
    slot: number,
  ): Promise<{ id: string; official: Actor }> {
    const official = await staffMember(t, ['official']);
    const offered = await post(t, '/v1/assignments', lm, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: fixtureId,
      role,
      slot,
      offer: true,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    const id = offered.body.assignment.id as string;
    const accept = await post(t, `/v1/assignments/${id}/accept`, official, {});
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    return { id, official };
  }

  /** The official pulls out inside the escalation window: the slot's exception is raised. */
  function withdraw(assignment: { id: string; official: Actor }) {
    return post(t, `/v1/assignments/${assignment.id}/withdraw`, assignment.official, {
      reason: 'Sick',
    });
  }

  async function withdrawn(assignment: { id: string; official: Actor }): Promise<string> {
    const res = await withdraw(assignment);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.uncovered, JSON.stringify(res.body)).toMatchObject({
      exceptionId: expect.any(String),
    });
    return res.body.uncovered.exceptionId as string;
  }

  const uncovered = (fixtureId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'status', 'dedupe_key', 'resolution'])
      .where('category', '=', UNCOVERED_ASSIGNMENT)
      .where('affected_type', '=', 'fixture')
      .where('affected_id', '=', fixtureId)
      .orderBy('dedupe_key')
      .execute();

  const slotKey = (fixtureId: string, role: string, slot: number) =>
    `${UNCOVERED_ASSIGNMENT}:fixture:${fixtureId}:${role}:${slot}`;

  /** The `workforce.unqualified_assignment` exceptions of the assignments, in the order given. */
  async function unqualified(assignmentIds: readonly string[]) {
    const rows = await t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'status', 'affected_id', 'resolution'])
      .where('category', '=', UNQUALIFIED_ASSIGNMENT)
      .where('affected_id', 'in', [...assignmentIds])
      .execute();
    return assignmentIds.map((id) => rows.filter((r) => r.affected_id === id));
  }

  async function resolvedReason(exceptionId: string) {
    return t.db
      .selectFrom('audit_records')
      .select(['reason', 'actor'])
      .where('action', '=', 'exceptions.resolved')
      .where('target_id', '=', exceptionId)
      .executeTakeFirstOrThrow();
  }

  /**
   * An operator closing the card on Today: support's `POST /v1/exceptions/:id/close` runs this
   * kernel transition, taking no workforce lock.
   */
  function operatorCloses(trx: Trx, id: string): Promise<void> {
    return t.app
      .get(OperationalExceptions)
      .transition(trx, systemPrincipal(t.organizationId, 'test.today_operator'), id, 'closed', {
        reason: 'Settled by phone',
      });
  }

  it('R4-OPS-MODULES-08 / SPK-UX-006: lowering the required count resolves the uncovered exception of a slot no longer required and keeps the one still required', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-01-16' });
    const req = await requirement(game.fixtureId, 'referee', 2);
    const first = await accepted(game.fixtureId, 'referee', 1);
    const second = await accepted(game.fixtureId, 'referee', 2);
    await withdrawn(first);
    await withdrawn(second);
    expect((await uncovered(game.fixtureId)).map((e) => [e.dedupe_key, e.status])).toEqual([
      [slotKey(game.fixtureId, 'referee', 1), 'open'],
      [slotKey(game.fixtureId, 'referee', 2), 'open'],
    ]);

    const lowered = await patchRequirement(req, { requiredCount: 1, reason: 'One referee only' });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    expect(lowered.body.coverage.uncoveredSlots).toEqual([1]);
    const after = await uncovered(game.fixtureId);
    expect(after.map((e) => [e.dedupe_key, e.status])).toEqual([
      [slotKey(game.fixtureId, 'referee', 1), 'open'],
      [slotKey(game.fixtureId, 'referee', 2), 'resolved'],
    ]);
    expect(after[1]?.resolution).toEqual({
      requirementId: req.id,
      requirementRevision: lowered.body.revision,
      requiredCount: 1,
      mustBeAccepted: true,
      slot: 2,
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['reason', 'actor'])
      .where('action', '=', 'exceptions.resolved')
      .where('target_id', '=', after[1]!.id)
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe(
      `Slot 2 is no longer required: the referee requirement now needs 1 accepted (revision ${lowered.body.revision}). One referee only`,
    );
    expect(audit.actor).toMatchObject({ kind: 'system', actorLabel: 'workforce.coverage' });

    // A repeat of an edit that changes nothing resolves nothing more (idempotent).
    const again = await patchRequirement(lowered.body as Requirement, { requiredCount: 1 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((await uncovered(game.fixtureId)).map((e) => e.status)).toEqual(['open', 'resolved']);
  });

  it('R4-OPS-MODULES-08 / SPK-UX-006: no longer demanding acceptance resolves every uncovered exception of the role, not those of another role', async () => {
    const game = await scheduleFixture(t, world, {
      date: '2027-01-17',
      from: '10:00',
      to: '11:00',
    });
    const referee = await requirement(game.fixtureId, 'referee', 1);
    await requirement(game.fixtureId, 'referee_assistant', 1);
    await withdrawn(await accepted(game.fixtureId, 'referee', 1));
    await withdrawn(await accepted(game.fixtureId, 'referee_assistant', 1));

    const relaxed = await patchRequirement(referee, { mustBeAccepted: false });
    expect(relaxed.status, JSON.stringify(relaxed.body)).toBe(200);
    const after = await uncovered(game.fixtureId);
    expect(after.map((e) => [e.dedupe_key, e.status])).toEqual([
      [slotKey(game.fixtureId, 'referee', 1), 'resolved'],
      [slotKey(game.fixtureId, 'referee_assistant', 1), 'open'],
    ]);
    expect(after[0]?.resolution).toMatchObject({ mustBeAccepted: false, slot: 1 });
  });

  it('R4-OPS-MODULES-08: an edit of the qualifications alone keeps the uncovered exceptions of required slots open', async () => {
    const game = await scheduleFixture(t, world, {
      date: '2027-01-17',
      from: '13:00',
      to: '14:00',
    });
    const req = await requirement(game.fixtureId, 'referee', 1);
    await withdrawn(await accepted(game.fixtureId, 'referee', 1));
    const edited = await patchRequirement(req, { requiredQualifications: ['referee_grade_9'] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await uncovered(game.fixtureId)).map((e) => e.status)).toEqual(['open']);
  });

  it('R4-OPS-MODULES-08 rework / SPK-UX-006 / SPK-STAFF-001: lowering the count resolves the unqualified-assignment card of an assignee whose slot is no longer required and keeps the one still required', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-01-20' });
    const req = await requirement(game.fixtureId, 'referee', 2);
    const first = await accepted(game.fixtureId, 'referee', 1);
    const second = await accepted(game.fixtureId, 'referee', 2);
    const demanding = await patchRequirement(req, { requiredQualifications: ['referee_grade_9'] });
    expect(demanding.status, JSON.stringify(demanding.body)).toBe(200);
    expect(
      (await unqualified([first.id, second.id])).map((rows) => rows.map((r) => r.status)),
    ).toEqual([['open'], ['open']]);

    const lowered = await patchRequirement(demanding.body as Requirement, {
      requiredCount: 1,
      reason: 'One referee only',
    });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    const [kept, settled] = await unqualified([first.id, second.id]);
    expect(kept?.map((r) => r.status)).toEqual(['open']);
    expect(settled?.map((r) => r.status)).toEqual(['resolved']);
    expect(settled?.[0]?.resolution).toEqual({
      requirementId: req.id,
      requirementRevision: lowered.body.revision,
      requiredCount: 1,
      requiredQualifications: ['referee_grade_9'],
      assignmentId: second.id,
      slot: 2,
      ground: 'slot_not_required',
    });
    const audit = await resolvedReason(settled![0]!.id);
    expect(audit.reason).toBe(
      `Slot 2 is no longer required: the referee requirement now requires 1 slot (revision ${lowered.body.revision}). One referee only`,
    );
    expect(audit.actor).toMatchObject({ kind: 'system', actorLabel: 'workforce.coverage' });
    // Readiness agrees: one accepted referee in a required slot lacks the qualification.
    const readiness = await t.http.get(`/v1/fixtures/${game.fixtureId}/readiness`).set(lm.header);
    expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
    expect(
      (readiness.body.issues as Array<{ code: string; message: string }>).find(
        (i) => i.code === 'required_official_unqualified',
      )?.message,
    ).toMatch(/^1 accepted referee assignment/);

    // A repeat of an edit that changes nothing resolves nothing more (idempotent).
    const again = await patchRequirement(lowered.body as Requirement, { requiredCount: 1 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(
      (await unqualified([first.id, second.id])).map((rows) => rows.map((r) => r.status)),
    ).toEqual([['open'], ['resolved']]);
  });

  it('R4-OPS-MODULES-08 rework / SPK-UX-006 / SPK-STAFF-001: dropping the qualification an assignee lacks resolves their unqualified-assignment card; an assignee still lacking one keeps theirs', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-01-21' });
    const req = await requirement(game.fixtureId, 'referee', 2);
    const first = await accepted(game.fixtureId, 'referee', 1);
    const second = await accepted(game.fixtureId, 'referee', 2);
    await createQualificationFixture(t, {
      personId: first.official.personId,
      kind: 'referee_grade_8',
    });
    const demanding = await patchRequirement(req, {
      requiredQualifications: ['referee_grade_8', 'referee_grade_9'],
    });
    expect(demanding.status, JSON.stringify(demanding.body)).toBe(200);
    expect(
      (await unqualified([first.id, second.id])).map((rows) => rows.map((r) => r.status)),
    ).toEqual([['open'], ['open']]);

    // The first assignee holds referee_grade_8 (verified, valid at the start); the second does not.
    const narrowed = await patchRequirement(demanding.body as Requirement, {
      requiredQualifications: ['referee_grade_8'],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    let [one, two] = await unqualified([first.id, second.id]);
    expect(one?.map((r) => r.status)).toEqual(['resolved']);
    expect(two?.map((r) => r.status)).toEqual(['open']);
    expect(one?.[0]?.resolution).toMatchObject({
      requirementRevision: narrowed.body.revision,
      requiredQualifications: ['referee_grade_8'],
      assignmentId: first.id,
      slot: 1,
      ground: 'qualified',
    });
    expect((await resolvedReason(one![0]!.id)).reason).toBe(
      `The assignee holds every qualification the referee requirement now names (referee_grade_8) (revision ${narrowed.body.revision}).`,
    );

    const dropped = await patchRequirement(narrowed.body as Requirement, {
      requiredQualifications: [],
      reason: 'Any referee will do',
    });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(200);
    [one, two] = await unqualified([first.id, second.id]);
    expect(one?.map((r) => r.status)).toEqual(['resolved']);
    expect(two?.map((r) => r.status)).toEqual(['resolved']);
    expect(two?.[0]?.resolution).toMatchObject({ requiredQualifications: [], ground: 'qualified' });
    expect((await resolvedReason(two![0]!.id)).reason).toBe(
      `The referee requirement no longer names a qualification (revision ${dropped.body.revision}). Any referee will do`,
    );
  });

  /**
   * A withdrawal escalating a slot and an edit lowering the count below it, overlapping. A gate
   * pauses the first command inside its open transaction while the second is sent. Under
   * TEST_DATABASE_URL the second waits for the requirement row lock the first holds (the share lock
   * of the withdrawal, the FOR UPDATE of the edit) and then reads what the first committed; under
   * PGlite it runs once the first commits. Either way no open exception is left on the slot the
   * edit no longer requires.
   */
  describe('withdrawal and requirement edit under concurrency (PGlite and TEST_DATABASE_URL)', () => {
    const pending: Array<{ restore: () => void }> = [];
    afterEach(() => {
      for (const spy of pending.splice(0)) spy.restore();
    });

    /** Pauses the first call of `method` on `target` matching `matches`, after it has run. */
    function pauseAfter<T extends object>(
      target: T,
      method: string,
      matches: (args: unknown[]) => boolean,
    ) {
      const host = target as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = host[method]!.bind(target);
      const paused = gate();
      let armed = true;
      const spy = vi.spyOn(host, method).mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        if (armed && matches(args)) {
          armed = false;
          await paused.pass();
        }
        return result;
      });
      pending.push({ restore: () => spy.mockRestore() });
      return paused;
    }

    /** Records the backend pid of each call of `method` matching `matches` (PostgreSQL only). */
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
      pending.push({ restore: () => spy.mockRestore() });
      return { pids };
    }

    async function overlap<A, B>(
      first: () => PromiseLike<A>,
      paused: ReturnType<typeof gate>,
      second: () => PromiseLike<B>,
      waiter: { pids: number[] },
    ): Promise<[A, B]> {
      const one = tracked(first());
      await paused.reached;
      const two = tracked(second());
      // PostgreSQL: the second command waits for the requirement row lock the paused one holds.
      if (t.database.concurrent) await untilSettledOrWaiting(t, two, () => waiter.pids[0]);
      paused.open();
      return Promise.all([one.promise, two.promise]);
    }

    it('R4-OPS-MODULES-08 / SPK-UX-006: an edit lowering the count, sent while a withdrawal escalating the slot is open, resolves the exception (PGlite and TEST_DATABASE_URL)', async () => {
      const game = await scheduleFixture(t, world, {
        date: '2027-01-17',
        from: '16:00',
        to: '17:00',
      });
      const req = await requirement(game.fixtureId, 'referee', 2);
      await accepted(game.fixtureId, 'referee', 1);
      const second = await accepted(game.fixtureId, 'referee', 2);
      const paused = pauseAfter(
        t.app.get(CoverageService),
        'escalateIfUncovered',
        (args) => (args[1] as { id: string }).id === second.id,
      );
      const editor = lockingReads(
        t.app.get(RequirementsService),
        'load',
        (args) => args[2] === req.id && args[3] === true,
      );
      const [pulledOut, lowered] = await overlap(
        () => withdraw(second),
        paused,
        () => patchRequirement(req, { requiredCount: 1 }),
        editor,
      );
      expect(pulledOut.status, JSON.stringify(pulledOut.body)).toBe(200);
      expect(pulledOut.body.uncovered).toMatchObject({ slot: 2 });
      expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
      expect((await uncovered(game.fixtureId)).map((e) => [e.dedupe_key, e.status])).toEqual([
        [slotKey(game.fixtureId, 'referee', 2), 'resolved'],
      ]);
    });

    it('R4-OPS-MODULES-08 / SPK-STAFF-003: a withdrawal sent while an edit lowering the count below its slot is open raises nothing (PGlite and TEST_DATABASE_URL)', async () => {
      const game = await scheduleFixture(t, world, {
        date: '2027-01-17',
        from: '19:00',
        to: '20:00',
      });
      const req = await requirement(game.fixtureId, 'referee', 2);
      await accepted(game.fixtureId, 'referee', 1);
      const second = await accepted(game.fixtureId, 'referee', 2);
      const paused = pauseAfter(
        t.app.get(CoverageService),
        'resolveUncoveredNoLongerRequired',
        (args) => (args[1] as { id: string }).id === req.id,
      );
      const withdrawer = lockingReads(
        t.app.get(CoverageService),
        'lockRequirementShared',
        (args) => args[2] === 'fixture' && args[3] === game.fixtureId,
      );
      const [lowered, pulledOut] = await overlap(
        () => patchRequirement(req, { requiredCount: 1 }),
        paused,
        () => withdraw(second),
        withdrawer,
      );
      expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
      expect(pulledOut.status, JSON.stringify(pulledOut.body)).toBe(200);
      expect(pulledOut.body.uncovered).toBeNull();
      expect(await uncovered(game.fixtureId)).toEqual([]);
    });

    /**
     * R4-OPS-MODULES-08 rework: an operator settles the card on Today after the edit found it open
     * and before the edit resolves it. Under TEST_DATABASE_URL the close commits from another
     * connection at that point; under PGlite (serialized transactions) it runs in the edit's own
     * transaction at the same point. Either way the edit skips the settled card and commits.
     */
    it('R4-OPS-MODULES-08 rework / SPK-UX-006: an uncovered card an operator closes after the edit read it never fails the edit (PGlite and TEST_DATABASE_URL)', async () => {
      const game = await scheduleFixture(t, world, {
        date: '2027-01-16',
        from: '14:00',
        to: '15:00',
      });
      const req = await requirement(game.fixtureId, 'referee', 2);
      await accepted(game.fixtureId, 'referee', 1);
      const exceptionId = await withdrawn(await accepted(game.fixtureId, 'referee', 2));
      const coverage = t.app.get(CoverageService);
      const host = coverage as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = host['lockSlotOf']!.bind(coverage);
      let armed = true;
      const spy = vi.spyOn(host, 'lockSlotOf').mockImplementation(async (...args: unknown[]) => {
        if (armed) {
          armed = false;
          if (t.database.concurrent) {
            // Another connection: committed before the edit goes on.
            await t.db.transaction().execute((other) => operatorCloses(other, exceptionId));
          } else {
            await operatorCloses(args[0] as Trx, exceptionId);
          }
        }
        return original(...args);
      });
      pending.push({ restore: () => spy.mockRestore() });

      const lowered = await patchRequirement(req, { requiredCount: 1, reason: 'One referee' });
      expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
      expect(armed).toBe(false);
      expect(lowered.body).toMatchObject({ requiredCount: 1, revision: req.revision + 1 });
      const [card] = await uncovered(game.fixtureId);
      expect(card).toMatchObject({ id: exceptionId, status: 'closed', resolution: null });
      const settled = await t.db
        .selectFrom('audit_records')
        .select(['action', 'reason'])
        .where('target_id', '=', exceptionId)
        .where('action', 'in', ['exceptions.closed', 'exceptions.resolved'])
        .execute();
      expect(settled).toEqual([{ action: 'exceptions.closed', reason: 'Settled by phone' }]);
    });

    /**
     * R4-OPS-MODULES-08 rework: an acceptance covering the slot reaches the card while an operator's
     * close of it is still uncommitted. Under TEST_DATABASE_URL the acceptance read the card as open
     * and waits for its row lock; once the close commits it sees the card closed and leaves it. Under
     * PGlite the close commits first. Either way the acceptance succeeds.
     */
    it('R4-OPS-MODULES-08 rework / SPK-UX-006: an acceptance covering a slot whose card an operator is closing never fails (PGlite and TEST_DATABASE_URL)', async () => {
      const game = await scheduleFixture(t, world, {
        date: '2027-01-18',
        from: '10:00',
        to: '11:00',
      });
      await requirement(game.fixtureId, 'referee', 1);
      const exceptionId = await withdrawn(await accepted(game.fixtureId, 'referee', 1));
      const official = await staffMember(t, ['official']);
      const offered = await post(t, '/v1/assignments', lm, {
        personId: official.personId,
        kind: 'official',
        targetType: 'fixture',
        targetId: game.fixtureId,
        role: 'referee',
        slot: 1,
        offer: true,
      });
      expect(offered.status, JSON.stringify(offered.body)).toBe(201);
      const assignmentId = offered.body.assignment.id as string;
      const acceptor = lockingReads(
        t.app.get(CoverageService),
        'resolveIfCovered',
        (args) => (args[1] as { id: string }).id === assignmentId,
      );

      const commit = gate();
      const operator = t.db.transaction().execute(async (trx) => {
        await operatorCloses(trx, exceptionId);
        // TEST_DATABASE_URL: hold the closed row, uncommitted, until the acceptance waits for it.
        if (t.database.concurrent) await commit.pass();
      });
      if (t.database.concurrent) await commit.reached;
      else await operator;
      const acceptance = tracked(post(t, `/v1/assignments/${assignmentId}/accept`, official, {}));
      if (t.database.concurrent) {
        await untilSettledOrWaiting(t, acceptance, () => acceptor.pids[0]);
        expect(acceptance.done).toBe(false);
      }
      commit.open();
      await operator;
      const covered = await acceptance.promise;
      expect(covered.status, JSON.stringify(covered.body)).toBe(200);
      expect(covered.body.assignment.status).toBe('accepted');
      expect((await uncovered(game.fixtureId)).map((e) => [e.id, e.status])).toEqual([
        [exceptionId, 'closed'],
      ]);
    });
  });
});
