import { newId } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import type { Clock } from '../../../kernel';
import { hashExportToken } from '../services/exports.service';

/**
 * Reporting fixtures for downstream module tests (automation, support). They write rows directly
 * through Kysely with the shapes the services write, so every constraint of migration 1300
 * applies. Report runs are normally produced by `ReportRunsService.create`; these fixtures exist
 * for tests that need a run, an export or an agreed cost input without evaluating a report.
 */
export interface ReportingFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
  facilityId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures', accountId: null, personId: null };

/** A stored run with an empty aggregate result (row count 0). */
export async function createReportRunFixture(
  ctx: ReportingFixtureContext,
  input: {
    reportKey?: string;
    facilityId?: string | null;
    asOf?: Date;
    requestedByAccountId?: string | null;
    requestedByPersonId?: string | null;
    organizationId?: string;
  } = {},
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const asOf = input.asOf ?? now;
  const reportKey = input.reportKey ?? 'daily_schedule';
  await ctx.db
    .insertInto('report_runs')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      facility_id: input.facilityId === undefined ? ctx.facilityId : input.facilityId,
      report_key: reportKey,
      parameters: json({ asOf: asOf.toISOString() }),
      reproducible_as_of: asOf,
      produced_at: now,
      point_in_time: 'partial',
      access_action: 'reporting.view_operations_reports',
      requested_by: json(FIXTURE_ACTOR),
      requested_by_account_id: input.requestedByAccountId ?? null,
      requested_by_person_id: input.requestedByPersonId ?? null,
      row_count: 0,
      result: json({ rows: [] }),
      result_digest: '0'.repeat(64),
      reproduces_run_id: null,
      reproduction_matched: null,
      correlation_id: null,
    })
    .execute();
  return id;
}

/** A ready export of a run; returns the one-time token so tests can download it. */
export async function createExportFixture(
  ctx: ReportingFixtureContext,
  input: {
    reportRunId: string;
    requestedByAccountId: string;
    requestedByPersonId?: string | null;
    format?: 'csv' | 'json';
    expiresAt?: Date;
    organizationId?: string;
  },
): Promise<{ exportId: string; token: string }> {
  const id = newId();
  const token = `spx_${newId().replaceAll('-', '')}${newId().replaceAll('-', '')}`;
  const now = ctx.clock.now();
  const run = await ctx.db
    .selectFrom('report_runs')
    .select(['report_key'])
    .where('organization_id', '=', input.organizationId ?? ctx.organizationId)
    .where('id', '=', input.reportRunId)
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('exports')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      report_run_id: input.reportRunId,
      report_key: run.report_key,
      format: input.format ?? 'csv',
      authorized_action: 'reporting.export_operational',
      requested_by: json({ ...FIXTURE_ACTOR, accountId: input.requestedByAccountId }),
      requested_by_account_id: input.requestedByAccountId,
      requested_by_person_id: input.requestedByPersonId ?? null,
      requested_at: now,
      expires_at: input.expiresAt ?? new Date(now.getTime() + 3_600_000),
      download_token_hash: hashExportToken(token),
      row_count: 0,
      content_digest: '0'.repeat(64),
      downloaded_at: null,
      downloaded_by: null,
      expired_at: null,
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
    })
    .execute();
  return { exportId: id, token };
}

/** An active agreed cost input per activity hour. */
export async function createCostInputFixture(
  ctx: ReportingFixtureContext,
  input: {
    amountMinor: number;
    currency?: string;
    resourceId?: string | null;
    facilityId?: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
    organizationId?: string;
    approvedByPersonId?: string | null;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('cost_inputs')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      facility_id: input.facilityId ?? ctx.facilityId,
      resource_id: input.resourceId ?? null,
      basis: 'per_activity_hour',
      amount_minor: input.amountMinor,
      currency: input.currency ?? 'USD',
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      description: 'Fixture cost input',
      approval_reference: 'fixture',
      approved_by: json(FIXTURE_ACTOR),
      approved_by_person_id: input.approvedByPersonId ?? null,
      recorded_at: ctx.clock.now(),
      withdrawn_at: null,
      withdrawn_by: null,
      withdrawn_reason: null,
    })
    .execute();
  return id;
}
