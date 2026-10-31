import { systemPrincipal, type MaintenanceTask, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OperationalExceptions,
  OutboxDispatcher,
  PeriodicJobRegistry,
  PeriodicJobRunner,
  UnitOfWork,
} from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { RAISE_OVERDUE_TASK_EXCEPTIONS_JOB } from '../services/facilities-jobs';
import { FacilitiesReader } from '../services/facilities-reader';
import { MaintenanceTasksService } from '../services/maintenance-tasks.service';
import { reportMaintenanceTask } from '../testing/facilities-fixtures';
import { keepFakePrincipals } from './support';

/**
 * FAC-03 (SPK-UX-006, SPK-FAC-002, §4.12): the overdue maintenance sweep runs as the periodic job
 * facilities.raise_overdue_task_exceptions. Tests call PeriodicJobRunner.runOnce after advancing
 * the FixedClock; the outbox due timer is deliberately not dispatched before the job runs, so the
 * exception comes from the job. ASYNC-09: the task command settles the exception when the task is
 * no longer overdue, and the sweep locks the tasks it raises for; the racing case pauses the sweep
 * before it raises and resolves the task meanwhile (under PGlite the command runs after the sweep
 * commits, under TEST_DATABASE_URL it waits for the sweep's row lock), with one outcome in both
 * modes: no open overdue exception for the resolved task.
 */
describe('overdue maintenance sweep (FAC-03, SPK-UX-006)', () => {
  let t: TestApp;
  let tasks: MaintenanceTasksService;
  let runner: PeriodicJobRunner;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    tasks = t.app.get(MaintenanceTasksService);
    runner = t.app.get(PeriodicJobRunner);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch J',
    });
    operator = staffPrincipal(org, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  const overdueExceptions = (taskId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('affected_id', '=', taskId)
      .where('category', '=', 'facilities.maintenance_task_overdue')
      .execute();
  const run = async () => {
    const [summary] = await runner.runOnce([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
    return summary;
  };

  it('is registered every 300 seconds, owned by the facilities operator queue (§4.12)', () => {
    const job = t.app.get(PeriodicJobRegistry).get(RAISE_OVERDUE_TASK_EXCEPTIONS_JOB);
    expect(job).toMatchObject({ intervalSeconds: 300, failureOwner: 'facilities_operator' });
  });

  it('an escalating task past due raises one exception when the job runs after FixedClock passes its due time', async () => {
    const critical = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.pitchId,
      issue: 'Floodlight bank 2 out',
      severity: 'critical',
      principal: operator,
    });
    // proposed default (pending, DEC-001): critical is due four hours after the report
    expect(critical.dueAt).toBe('2026-10-19T16:00:00.000Z');
    const medium = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      issue: 'Corner flag missing',
      severity: 'medium',
      dueAt: '2026-10-19T13:00:00.000Z',
      principal: operator,
    });
    // another organization with an active facility is swept in its own transaction
    const other = await seedOrganization(t.db);
    const otherPitch = await seedPitchWithHalves(t.db, {
      organizationId: other.organizationId,
      facilityId: other.facilityId,
      name: 'Other pitch',
    });
    const otherCritical = await reportMaintenanceTask(tasks, {
      organizationId: other.organizationId,
      facilityId: other.facilityId,
      resourceId: otherPitch.pitchId,
      issue: 'Gate lock broken',
      severity: 'critical',
      principal: staffPrincipal(other.organizationId, ['facilities_operator']),
    });

    const early = await run();
    expect(early).toMatchObject({ ran: true, failed: false, processed: 0 });
    expect(await overdueExceptions(critical.id)).toEqual([]);

    t.clock.advance(5 * 3_600_000);
    const due = await run();
    expect(due).toMatchObject({ ran: true, failed: false, processed: 2, remaining: 0 });
    const raised = await overdueExceptions(critical.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      organization_id: org,
      facility_id: facility,
      severity: 'critical',
      owner_queue: 'facilities_operator',
      status: 'open',
      dedupe_key: `maintenance_task:${critical.id}:overdue`,
    });
    expect(new Date(raised[0]?.deadline_at as Date).toISOString()).toBe(critical.dueAt);
    // a non-escalating severity is listed as overdue but never raised (FACILITIES_POLICY)
    expect(await overdueExceptions(medium.id)).toEqual([]);
    expect(await overdueExceptions(otherCritical.id)).toEqual([
      expect.objectContaining({ organization_id: other.organizationId, status: 'open' }),
    ]);
  });

  it('a second run raises nothing new', async () => {
    const before = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('category', '=', 'facilities.maintenance_task_overdue')
      .execute();
    expect(before).toHaveLength(2);
    // inside the interval the runner does not run the job again
    expect(await run()).toMatchObject({ ran: false });
    t.clock.advance(301_000);
    const again = await run();
    expect(again).toMatchObject({ ran: true, failed: false });
    // the outbox due timers fire too: the dedupe key keeps one open exception per task
    await t.app.get(OutboxDispatcher).runOnce(100);
    const after = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('category', '=', 'facilities.maintenance_task_overdue')
      .execute();
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });
  const openOverdue = async (taskId: string) =>
    (await overdueExceptions(taskId)).filter(
      (e) => e.status === 'open' || e.status === 'acknowledged',
    );
  // critical escalates under the proposed FACILITIES_POLICY default (pending, DEC-001)
  const reportDueSoon = (issue: string) =>
    reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.pitchId,
      issue,
      severity: 'critical',
      dueAt: new Date(t.clock.now().getTime() + 30 * 60_000).toISOString(),
      principal: operator,
    });

  it('SPK-UX-006 (ASYNC-09): resolving, closing, re-dating or de-escalating an overdue task settles its exception, and the sweep raises nothing for it again', async () => {
    const resolved = await reportDueSoon('Floodlight bank 3 out');
    const closed = await reportDueSoon('Gate hinge snapped');
    const redated = await reportDueSoon('Netting torn');
    const lowered = await reportDueSoon('Scoreboard flicker');
    const untouched = await reportDueSoon('Drain blocked');
    t.clock.advance(3_600_000);
    await t.runPeriodicJobs([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
    for (const task of [resolved, closed, redated, lowered, untouched]) {
      expect(await openOverdue(task.id), task.issue).toHaveLength(1);
    }
    // an acknowledged exception is settled too
    const [closedException] = await openOverdue(closed.id);
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get(OperationalExceptions)
          .transition(trx, systemPrincipal(org, 'test'), closedException!.id, 'acknowledged'),
      );

    await tasks.update(operator, resolved.id, {
      status: 'resolved',
      resolution: { summary: 'breaker reset' },
      expectedRevision: resolved.revision,
    });
    await tasks.update(operator, closed.id, {
      status: 'closed',
      resolution: { summary: 'hinge replaced' },
      expectedRevision: closed.revision,
    });
    const later = new Date(t.clock.now().getTime() + 2 * 3_600_000).toISOString();
    await tasks.update(operator, redated.id, { dueAt: later, expectedRevision: redated.revision });
    await tasks.update(operator, lowered.id, {
      severity: 'high',
      expectedRevision: lowered.revision,
    });
    // an edit that leaves the task overdue keeps its exception
    await tasks.update(operator, untouched.id, {
      issue: 'Drain blocked near the north goal',
      expectedRevision: untouched.revision,
    });

    const settled = async (task: MaintenanceTask) => {
      const [row] = await overdueExceptions(task.id);
      return { status: row?.status, resolution: row?.resolution };
    };
    expect(await settled(resolved)).toEqual({
      status: 'resolved',
      resolution: expect.objectContaining({ taskId: resolved.id, taskStatus: 'resolved' }),
    });
    expect(await settled(closed)).toEqual({
      status: 'resolved',
      resolution: expect.objectContaining({ taskStatus: 'closed' }),
    });
    expect(await settled(redated)).toEqual({
      status: 'resolved',
      resolution: expect.objectContaining({ taskStatus: 'open', dueAt: later }),
    });
    expect(await settled(lowered)).toEqual({
      status: 'resolved',
      resolution: expect.objectContaining({ severity: 'high' }),
    });
    expect(await openOverdue(untouched.id)).toHaveLength(1);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason', 'actor'])
      .where('target_type', '=', 'operational_exception')
      .where('target_id', '=', closedException!.id)
      .where('action', '=', 'exceptions.resolved')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('The maintenance task was closed.');

    // the next runs raise nothing for the settled tasks; the re-dated one is raised anew once due
    t.clock.advance(301_000);
    await t.runPeriodicJobs([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
    for (const task of [resolved, closed, redated, lowered]) {
      expect(await openOverdue(task.id), task.issue).toEqual([]);
    }
    t.clock.advance(2 * 3_600_000);
    await t.runPeriodicJobs([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
    expect(await openOverdue(redated.id)).toHaveLength(1);
    expect(await openOverdue(resolved.id)).toEqual([]);
  });

  /** A promise that stays pending until `open()`; `reached` resolves when someone waits on it. */
  function gate() {
    let open!: () => void;
    let arrive!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    return {
      reached,
      open,
      pass: async () => {
        arrive();
        await opened;
      },
    };
  }
  /** Tracks whether a promise has settled. */
  function tracked<T>(promise: Promise<T>) {
    const state = { done: false, promise };
    void promise.then(
      () => (state.done = true),
      () => (state.done = true),
    );
    return state;
  }
  /**
   * TEST_DATABASE_URL: the backend pid of every locking read of `taskId` (the task command, the
   * due timer handler), so a test can tell when one of them waits for the other's row lock.
   */
  function lockingReaders(taskId: string) {
    const reader = t.app.get(FacilitiesReader);
    const loadTask = reader.loadTask.bind(reader);
    const pids: number[] = [];
    const spy = vi.spyOn(reader, 'loadTask').mockImplementation(async (db, o, id, lock) => {
      if (t.database.concurrent && id === taskId && lock) {
        const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        if (rows[0]) pids.push(rows[0].pid);
      }
      return loadTask(db, o, id, lock);
    });
    return { pids, restore: () => spy.mockRestore() };
  }
  /** TEST_DATABASE_URL: returns once `work` has settled or the backend `pid()` waits for a lock. */
  async function untilSettledOrWaiting(work: { done: boolean }, pid: () => number | undefined) {
    for (let polls = 0; !work.done; polls += 1) {
      if (polls > 2000) throw new Error('the work neither finished nor waited for a row lock');
      const waiting = pid();
      if (waiting !== undefined) {
        const { rows } = await sql<{ wait: string | null }>`
          select wait_event_type as wait from pg_stat_activity where pid = ${waiting}`.execute(
          t.db,
        );
        if (rows[0]?.wait === 'Lock') return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('§4.12 (ASYNC-09): a task resolved while the sweep is raising its exception keeps no open overdue exception (PGlite and TEST_DATABASE_URL)', async () => {
    const task = await reportDueSoon('Turf seam lifted at the halfway line');
    t.clock.advance(3_600_000);
    const exceptions = t.app.get(OperationalExceptions);
    const raise = exceptions.raise.bind(exceptions);
    const beforeRaise = gate();
    const raiseSpy = vi.spyOn(exceptions, 'raise').mockImplementation(async (trx, input) => {
      // the sweep has read the task as open and overdue, inside its open transaction
      if (input.affectedId === task.id) await beforeRaise.pass();
      return raise(trx, input);
    });
    const readers = lockingReaders(task.id);
    try {
      const sweep = t.runPeriodicJobs([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
      await beforeRaise.reached;
      const resolving = tracked(
        tasks.update(operator, task.id, {
          status: 'resolved',
          resolution: { summary: 'seam glued' },
          expectedRevision: task.revision,
        }),
      );
      // PostgreSQL: the command either finishes beside the paused sweep (the race) or waits for
      // the task row the sweep holds. PGlite: the command runs once the sweep commits.
      if (t.database.concurrent) await untilSettledOrWaiting(resolving, () => readers.pids[0]);
      beforeRaise.open();
      const [summary, updated] = await Promise.all([sweep, resolving.promise]);
      expect(summary).toEqual([expect.objectContaining({ ran: true, failed: false })]);
      expect(updated.status).toBe('resolved');
    } finally {
      raiseSpy.mockRestore();
      readers.restore();
    }
    expect(await openOverdue(task.id)).toEqual([]);
    // a later run does not raise it again
    t.clock.advance(301_000);
    await t.runPeriodicJobs([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
    expect(await openOverdue(task.id)).toEqual([]);
  });

  it('§4.12 (ASYNC-09): the due timer of a task being resolved never escalates it (PGlite and TEST_DATABASE_URL)', async () => {
    const task = await reportDueSoon('Goal anchor loose');
    t.clock.advance(3_600_000);
    const reader = t.app.get(FacilitiesReader);
    const taskView = reader.taskView.bind(reader);
    const beforeCommit = gate();
    const viewSpy = vi.spyOn(reader, 'taskView').mockImplementation(async (db, row) => {
      // the command resolved the task and settled its exceptions; it holds the row, uncommitted
      if (row.id === task.id && row.status === 'resolved') await beforeCommit.pass();
      return taskView(db, row);
    });
    const readers = lockingReaders(task.id);
    try {
      const resolving = tracked(
        tasks.update(operator, task.id, {
          status: 'resolved',
          resolution: { summary: 'anchor bolted' },
          expectedRevision: task.revision,
        }),
      );
      await beforeCommit.reached;
      // the due timer (available since the due instant) is delivered while the command is open
      const dispatching = tracked(t.app.get(OutboxDispatcher).runOnce(100));
      // PostgreSQL: the handler either escalates from the last committed row (the race) or waits
      // for the row the command holds. PGlite: the handler runs once the command commits.
      if (t.database.concurrent) await untilSettledOrWaiting(dispatching, () => readers.pids[1]);
      beforeCommit.open();
      const [updated] = await Promise.all([resolving.promise, dispatching.promise]);
      expect(updated.status).toBe('resolved');
    } finally {
      viewSpy.mockRestore();
      readers.restore();
    }
    expect(await overdueExceptions(task.id)).toEqual([]);
  });
});
