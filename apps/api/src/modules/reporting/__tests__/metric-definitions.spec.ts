import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { METRICS } from '../reporting.metrics';
import { MetricDefinitionsService } from '../services/metric-definitions.service';
import { customer, get, post, reportingTestApp, staff, type Actor } from './support';

const FIELDS = [
  'businessQuestion',
  'grain',
  'numerator',
  'denominator',
  'timeBasis',
  'exclusions',
  'dimensions',
  'currency',
  'freshness',
  'accessScope',
] as const;

describe('metric definitions (SPK-REPORT-001)', () => {
  let t: TestApp;
  let frontDesk: Actor;

  beforeAll(async () => {
    t = await reportingTestApp();
    frontDesk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-001: every metric defines its question, grain, numerator and denominator, time basis, exclusions, dimensions, currency, freshness and access scope', async () => {
    const res = await get(t, '/v1/reports/metric-definitions', frontDesk);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(METRICS.length);
    for (const item of res.body.items) {
      for (const field of FIELDS) expect(item, `${item.metricKey} ${field}`).toHaveProperty(field);
      for (const field of [
        'businessQuestion',
        'grain',
        'numerator',
        'denominator',
        'timeBasis',
        'accessScope',
      ] as const) {
        expect(String(item[field]).length, `${item.metricKey} ${field}`).toBeGreaterThan(0);
      }
      expect(['none', 'minor_units']).toContain(item.currency);
      expect(['F1', 'F2', 'F3']).toContain(item.freshness);
      expect(item.version).toBe(1);
      expect(item.requirementIds.length).toBeGreaterThan(0);
    }
    const utilization = await get(t, '/v1/reports/metric-definitions', frontDesk, {
      report: 'utilization',
    });
    expect(utilization.body.items.map((m: { metricKey: string }) => m.metricKey)).toEqual([
      'MET-064',
      'MET-065',
      'MET-066',
      'MET-067',
      'MET-068',
      'MET-069',
      'MET-070',
      'MET-071',
      'MET-072',
      'MET-073',
    ]);
  });

  it('SPK-REPORT-007: a changed definition is a new version; earlier runs keep citing the version they used', async () => {
    const scheduler = await staff(t, ['scheduler']);
    const run = await post(t, '/v1/reports/runs', scheduler, {
      report: 'utilization',
      parameters: { facilityId: t.facilityId, from: '2027-02-03', to: '2027-02-03' },
    });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const v1 = run.body.result.metrics.find(
      (m: { metricKey: string }) => m.metricKey === 'MET-065',
    );

    const changed = METRICS.map((m) =>
      m.key === 'MET-065' ? { ...m, numerator: `${m.numerator} (clarified)` } : m,
    );
    await t.app.get(MetricDefinitionsService).ensureSeeded(t.organizationId, changed);

    const versions = await t.db
      .selectFrom('metric_definitions')
      .select(['id', 'version', 'status', 'numerator'])
      .where('organization_id', '=', t.organizationId)
      .where('metric_key', '=', 'MET-065')
      .orderBy('version')
      .execute();
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'superseded'],
      [2, 'active'],
    ]);
    expect(versions[1]!.numerator).toContain('(clarified)');

    // The stored run still cites version 1, exactly as it was produced.
    const stored = await get(t, `/v1/reports/runs/${run.body.id}`, scheduler);
    const cited = stored.body.result.metrics.find(
      (m: { metricKey: string }) => m.metricKey === 'MET-065',
    );
    expect(cited.id).toBe(v1.id);
    expect(cited.version).toBe(1);
    expect(stored.body.metricDefinitionIds).toContain(v1.id);

    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'details'])
      .where('action', '=', 'reporting.metric_definition_versioned')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({
      metricKey: 'MET-065',
      version: 2,
      supersededDefinitionId: v1.id,
    });
    expect(
      await t.db
        .selectFrom('outbox_events')
        .select('id')
        .where('event_type', '=', 'reporting.metric_definition_versioned')
        .execute(),
    ).toHaveLength(1);

    // The code registry is the source: the next read restores its wording as version 3.
    const history = await get(t, '/v1/reports/metric-definitions/MET-065', frontDesk);
    expect(history.status).toBe(200);
    expect(history.body.active.version).toBe(3);
    expect(history.body.active.definitionHash).toBe(v1.definitionHash);
    expect(
      history.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]),
    ).toEqual([
      [3, 'active'],
      [2, 'superseded'],
      [1, 'superseded'],
    ]);
  });

  it('access: staff viewers read definitions; customers do not; unknown metrics are not found', async () => {
    const member = await customer(t);
    expect((await get(t, '/v1/reports/metric-definitions', member)).status).toBe(403);
    expect((await get(t, '/v1/reports/metric-definitions/MET-999', frontDesk)).status).toBe(404);
    expect((await get(t, '/v1/reports/metric-definitions/not-a-key', frontDesk)).status).toBe(400);
  });
});
