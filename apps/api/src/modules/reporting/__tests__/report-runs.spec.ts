import type { StaffRole } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createOfferingSessionFixture } from '../../catalog';
import { createEnrollmentFixture } from '../../enrollment';
import { createAttendanceObservationFixture } from '../../entry';
import { createPersonFixture } from '../../identity';
import { at } from '../../scheduling';
import {
  customer,
  get,
  HOUR,
  key,
  post,
  reportingTestApp,
  staff,
  valueOf,
  type Actor,
} from './support';

const DATE = '2027-02-03';

describe('report runs (SPK-REPORT-007, SPK-REPORT-001)', () => {
  let t: TestApp;
  let manager: Actor;
  let offeringId: string;
  let sessionId: string;
  let childId: string;
  let firstObservationId: string;

  const attendanceParams = () => ({ facilityId: t.facilityId, from: DATE, to: DATE });

  beforeAll(async () => {
    t = await reportingTestApp();
    manager = await staff(t, ['general_manager']);
    offeringId = (
      await createOfferingFixture(t, {
        responsibleManagerPersonId: manager.personId,
        kind: 'term',
        startsOn: DATE,
        endsOn: '2027-03-31',
      })
    ).offeringId;
    sessionId = await createOfferingSessionFixture(t, {
      offeringId,
      scheduledStart: new Date(at(DATE, '17:00')),
      scheduledEnd: new Date(at(DATE, '18:00')),
    });
    childId = await createPersonFixture(t, { kind: 'child' });
    await createEnrollmentFixture(t, {
      offeringId,
      participantPersonId: childId,
      status: 'confirmed',
    });
    firstObservationId = await createAttendanceObservationFixture(t, {
      personId: childId,
      activity: { type: 'session', offeringId, sessionId },
      observedState: 'present',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-007: reports are reproducible after a correction (stored run, same-as-of rerun, later as-of reflects it)', async () => {
    const created = await post(t, '/v1/reports/runs', manager, {
      report: 'attendance',
      parameters: attendanceParams(),
      reason: 'Weekly attendance review',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run = created.body;
    const asOf = run.asOf;
    expect(valueOf(run.result, 'MET-007', 'Attended')).toBe(1);
    expect(valueOf(run.result, 'MET-008')).toBe(1);
    expect(run.result.runId).toBe(run.id);
    expect(run.result.freshness.class).toBe('F3');
    expect(run.rowCount).toBe(1);

    // The coach corrects the record an hour later: the child was absent (SPK-ENTRY-005).
    t.clock.advance(HOUR);
    await createAttendanceObservationFixture(t, {
      personId: childId,
      activity: { type: 'session', offeringId, sessionId },
      observedState: 'absent',
      correctsObservationId: firstObservationId,
      correctionReason: 'Marked present by mistake',
    });

    // The stored run is unchanged.
    const stored = await get(t, `/v1/reports/runs/${run.id}`, manager);
    expect(stored.status).toBe(200);
    expect(stored.body.resultDigest).toBe(run.resultDigest);
    expect(valueOf(stored.body.result, 'MET-007', 'Attended')).toBe(1);

    // Re-evaluated at the same as-of instant it produces exactly the same figures.
    const reproduced = await post(t, `/v1/reports/runs/${run.id}/reproduce`, manager, {});
    expect(reproduced.status, JSON.stringify(reproduced.body)).toBe(201);
    expect(reproduced.body.matched).toBe(true);
    expect(reproduced.body.reproducedDigest).toBe(run.resultDigest);
    expect(reproduced.body.reproducedRun.reproducesRunId).toBe(run.id);
    expect(reproduced.body.reproducedRun.asOf).toBe(asOf);

    // Evaluated now, the correction is reflected.
    const live = await get(t, '/v1/reports/attendance', manager, attendanceParams());
    expect(live.status).toBe(200);
    expect(valueOf(live.body, 'MET-007', 'Attended')).toBe(0);
    expect(valueOf(live.body, 'MET-007', 'Observed absent')).toBe(1);
    expect(valueOf(live.body, 'MET-011')).toBe(1);

    const audits = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('organization_id', '=', t.organizationId)
      .where('target_type', '=', 'report_run')
      .execute();
    expect(audits.map((a) => a.action).sort()).toEqual([
      'reporting.report_run_recorded',
      'reporting.report_run_reproduced',
    ]);
  });

  it('SPK-REPORT-001: a stored run cites the exact metric definition versions it was produced under', async () => {
    const created = await post(t, '/v1/reports/runs', manager, {
      report: 'daily_schedule',
      parameters: { facilityId: t.facilityId, date: DATE },
    });
    expect(created.status).toBe(201);
    const ids = created.body.result.metrics.map((m: { id: string }) => m.id).sort();
    expect(created.body.metricDefinitionIds).toEqual(ids);
    expect(created.body.result.metrics.map((m: { metricKey: string }) => m.metricKey)).toEqual([
      'MET-001',
      'MET-002',
      'MET-003',
    ]);
    const links = await t.db
      .selectFrom('report_run_metrics')
      .select('metric_definition_id')
      .where('report_run_id', '=', created.body.id)
      .execute();
    expect(links.map((l) => l.metric_definition_id).sort()).toEqual(ids);
  });

  it('§4.9: replaying a run with the same idempotency key returns the same run once', async () => {
    const idempotencyKey = key();
    const body = { report: 'daily_schedule', parameters: { facilityId: t.facilityId, date: DATE } };
    const first = await post(t, '/v1/reports/runs', manager, body, idempotencyKey);
    const second = await post(t, '/v1/reports/runs', manager, body, idempotencyKey);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const rows = await t.db
      .selectFrom('report_runs')
      .select('id')
      .where('id', '=', first.body.id)
      .execute();
    expect(rows).toHaveLength(1);
    const conflict = await post(
      t,
      '/v1/reports/runs',
      manager,
      { ...body, parameters: { ...body.parameters, date: '2027-02-04' } },
      idempotencyKey,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('§4.10 / G1: a run is not found across organizations, nor for a customer; a facility of another organization is not found', async () => {
    const run = await post(t, '/v1/reports/runs', manager, {
      report: 'attendance',
      parameters: attendanceParams(),
    });
    expect(run.status).toBe(201);
    const other = await seedOrganization(t.db, { slug: 'other-org' });
    const outsider = await staff(t, ['general_manager'], { organizationId: other.organizationId });
    const crossOrg = await get(t, `/v1/reports/runs/${run.body.id}`, outsider);
    expect(crossOrg.status).toBe(404);
    expect(crossOrg.body.code).toBe('NOT_FOUND');
    const crossFacility = await get(t, '/v1/reports/attendance', outsider, attendanceParams());
    expect(crossFacility.status).toBe(404);

    const member = await customer(t);
    const asCustomer = await get(t, `/v1/reports/runs/${run.body.id}`, member);
    expect(asCustomer.status).toBe(404);
    expect(asCustomer.body.code).toBe('NOT_FOUND');
    expect((await get(t, '/v1/reports/attendance', member, attendanceParams())).status).toBe(403);
    expect((await post(t, `/v1/reports/runs/${run.body.id}/reproduce`, member, {})).status).toBe(
      404,
    );

    // A staff member without the report's view action cannot see that the run exists either.
    const finance = await staff(t, ['finance_operator']);
    expect((await get(t, `/v1/reports/runs/${run.body.id}`, finance)).status).toBe(404);
  });

  it('SPK-REPORT-007: live-only reports refuse a past as-of instant and cannot be reproduced; no report runs as of the future', async () => {
    const past = new Date(t.clock.now().getTime() - HOUR).toISOString();
    const readiness = await get(t, '/v1/reports/match-readiness', manager, {
      facilityId: t.facilityId,
      from: DATE,
      to: DATE,
      asOf: past,
    });
    expect(readiness.status).toBe(400);
    expect(readiness.body.details.code).toBe('live_only');
    const future = await get(t, '/v1/reports/attendance', manager, {
      ...attendanceParams(),
      asOf: new Date(t.clock.now().getTime() + HOUR).toISOString(),
    });
    expect(future.status).toBe(400);
    const liveRun = await post(t, '/v1/reports/runs', manager, {
      report: 'maintenance_restrictions',
      parameters: { facilityId: t.facilityId },
    });
    expect(liveRun.status).toBe(201);
    const reproduce = await post(t, `/v1/reports/runs/${liveRun.body.id}/reproduce`, manager, {});
    expect(reproduce.status).toBe(400);
  });

  it('lists stored runs the caller may view, newest first, with pagination', async () => {
    const list = await get(t, '/v1/reports/runs', manager, { limit: '2' });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.nextCursor).toBeTruthy();
    const next = await get(t, '/v1/reports/runs', manager, {
      limit: '2',
      cursor: list.body.nextCursor,
    });
    expect(next.status).toBe(200);
    const ids = [...list.body.items, ...next.body.items].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const scheduler = await staff(t, ['scheduler']);
    const theirs = await get(t, '/v1/reports/runs', scheduler, { report: 'attendance' });
    expect(theirs.status).toBe(200);
    expect(
      theirs.body.items.every((r: { reportKey: string }) => r.reportKey === 'attendance'),
    ).toBe(true);
    const finance = await staff(t, ['finance_operator']);
    const none = await get(t, '/v1/reports/runs', finance, { report: 'attendance' });
    expect(none.body.items).toHaveLength(0);
  });

  it('staff role matrix (permission matrix C.14): who may view each report family', async () => {
    const roles: StaffRole[] = [
      'front_desk',
      'league_manager',
      'program_manager',
      'scheduler',
      'finance_operator',
      'facilities_operator',
      'general_manager',
      'system_administrator',
      'support_operator',
      'coach',
      'official',
    ];
    const families: Array<{ path: string; query: Record<string, string>; allowed: StaffRole[] }> = [
      {
        path: 'daily-schedule',
        query: { facilityId: t.facilityId, date: DATE },
        allowed: [
          'front_desk',
          'league_manager',
          'program_manager',
          'scheduler',
          'facilities_operator',
          'general_manager',
          'system_administrator',
          'support_operator',
        ],
      },
      {
        path: 'registration-funnel',
        query: { facilityId: t.facilityId, from: DATE, to: DATE },
        allowed: ['league_manager', 'program_manager', 'general_manager', 'system_administrator'],
      },
      {
        path: 'outstanding-obligations',
        query: {},
        allowed: ['finance_operator', 'general_manager'],
      },
      {
        path: 'utilization',
        query: { facilityId: t.facilityId, from: DATE, to: DATE },
        allowed: ['scheduler', 'finance_operator', 'facilities_operator', 'general_manager'],
      },
      {
        path: 'retention',
        query: {
          cohort: 'households',
          anchorFrom: '2027-01-01',
          anchorTo: '2027-01-31',
          comparisonFrom: '2027-02-01',
          comparisonTo: '2027-02-28',
        },
        allowed: ['league_manager', 'program_manager', 'general_manager'],
      },
    ];
    for (const role of roles) {
      const actor = await staff(t, [role]);
      for (const family of families) {
        const res = await get(t, `/v1/reports/${family.path}`, actor, family.query);
        const expected = family.allowed.includes(role) ? 200 : 403;
        expect(res.status, `${role} on ${family.path}: ${JSON.stringify(res.body)}`).toBe(expected);
      }
    }
  });
});
