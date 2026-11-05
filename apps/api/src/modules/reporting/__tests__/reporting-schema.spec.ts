import { newId } from '@sportspark/contracts';
import { json, seedOrganization, type Database } from '@sportspark/db';
import { sql, type SelectType } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createAccountFixture, createPersonFixture } from '../../identity';
import { seedResource } from '../../scheduling';
import { MetricDefinitionsService } from '../services/metric-definitions.service';
import {
  createCostInputFixture,
  createExportFixture,
  createReportRunFixture,
} from '../testing/reporting-fixtures';
import { expectPgError, HOUR, reportingTestApp } from './support';

const RESTRICT = '23001';
const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const CHECK = '23514';
const EXCLUSION = '23P01';

type ReportingViewName = Extract<keyof Database, `reporting_${string}_v`>;
/** The string literals a reporting view column is typed with in the Kysely schema. */
type ViewLiterals<V extends ReportingViewName, C extends keyof Database[V]> = Extract<
  SelectType<Database[V][C]>,
  string
>;
interface PassThroughState {
  view: string;
  column: string;
  table: string;
  baseColumn: string;
  typed: string[];
}
/**
 * A view column that passes a base table's check-constrained column through unfiltered. `typed`
 * must name every literal of the column's Kysely union and nothing more: the compiler rejects a
 * missing or an extra key, and the test compares the list with the base table's check constraint.
 */
const passThrough = <V extends ReportingViewName, C extends keyof Database[V] & string>(
  view: V,
  column: C,
  table: string,
  baseColumn: string,
  typed: Record<ViewLiterals<V, C>, true>,
): PassThroughState => ({ view, column, table, baseColumn, typed: Object.keys(typed).sort() });

/**
 * Integrity invariants enforced by the database (migration 1300), proven by writing violating rows
 * directly: the services' checks give earlier feedback but are not the guarantee (§4.7).
 */
describe('reporting schema invariants (migration 1300)', () => {
  let t: TestApp;
  let otherOrganizationId: string;
  let otherFacilityId: string;

  beforeAll(async () => {
    t = await reportingTestApp();
    await t.app.get(MetricDefinitionsService).ensureSeeded(t.organizationId);
    const other = await seedOrganization(t.db, { slug: 'schema-other' });
    otherOrganizationId = other.organizationId;
    otherFacilityId = other.facilityId;
  });
  afterAll(async () => {
    await t.close();
  });

  const activeDefinition = (metricKey = 'MET-065') =>
    t.db
      .selectFrom('metric_definitions')
      .selectAll()
      .where('organization_id', '=', t.organizationId)
      .where('metric_key', '=', metricKey)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();

  it('SPK-REPORT-001: one active version per metric; a definition version is immutable and never deleted', async () => {
    const active = await activeDefinition();
    const { id: _id, created_at: _c, updated_at: _u, ...copy } = active;
    await expectPgError(
      t.db
        .insertInto('metric_definitions')
        .values({ ...copy, id: newId(), version: active.version + 1 })
        .execute(),
      UNIQUE,
    );
    await expectPgError(
      t.db
        .updateTable('metric_definitions')
        .set({ numerator: 'changed in place' })
        .where('id', '=', active.id)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db.deleteFrom('metric_definitions').where('id', '=', active.id).execute(),
      RESTRICT,
    );
    await expectPgError(
      t.db
        .updateTable('metric_definitions')
        .set({ status: 'superseded' })
        .where('id', '=', active.id)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('metric_definitions')
      .set({ status: 'superseded', superseded_at: t.clock.now() })
      .where('id', '=', active.id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('metric_definitions')
        .set({ status: 'active', superseded_at: null })
        .where('id', '=', active.id)
        .execute(),
      CHECK,
    );
  });

  it('SPK-REPORT-007: report runs and their definition links are append-only and organization-bound', async () => {
    const runId = await createReportRunFixture(t);
    await expectPgError(
      t.db.updateTable('report_runs').set({ row_count: 0 }).where('id', '=', runId).execute(),
      RESTRICT,
    );
    await expectPgError(t.db.deleteFrom('report_runs').where('id', '=', runId).execute(), RESTRICT);
    // The stored row count must match the stored rows.
    await expectPgError(
      t.db
        .insertInto('report_runs')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          facility_id: null,
          report_key: 'daily_schedule',
          parameters: json({}),
          reproducible_as_of: t.clock.now(),
          produced_at: t.clock.now(),
          point_in_time: 'partial',
          access_action: 'reporting.view_operations_reports',
          requested_by: json({ kind: 'system' }),
          requested_by_account_id: null,
          requested_by_person_id: null,
          row_count: 2,
          result: json({ rows: [{ a: 1 }] }),
          result_digest: 'a'.repeat(64),
          reproduces_run_id: null,
          reproduction_matched: null,
          correlation_id: null,
        })
        .execute(),
      CHECK,
    );
    // Never as of the future relative to its production.
    await expectPgError(
      createReportRunFixture(t, { asOf: new Date(t.clock.now().getTime() + HOUR) }),
      CHECK,
    );
    // A run cannot point at another organization's facility.
    await expectPgError(createReportRunFixture(t, { facilityId: otherFacilityId }), FOREIGN_KEY);
    // A run cannot cite another organization's metric definition.
    const otherRun = await createReportRunFixture(t, {
      organizationId: otherOrganizationId,
      facilityId: otherFacilityId,
    });
    const definition = await activeDefinition('MET-001');
    await expectPgError(
      t.db
        .insertInto('report_run_metrics')
        .values({
          organization_id: otherOrganizationId,
          report_run_id: otherRun,
          metric_definition_id: definition.id,
        })
        .execute(),
      FOREIGN_KEY,
    );
    await t.db
      .insertInto('report_run_metrics')
      .values({
        organization_id: t.organizationId,
        report_run_id: runId,
        metric_definition_id: definition.id,
      })
      .execute();
    await expectPgError(
      t.db.deleteFrom('report_run_metrics').where('report_run_id', '=', runId).execute(),
      RESTRICT,
    );
  });

  it('§4.14: an export is never downloaded at or after its expiry; its lifecycle and authorization are final', async () => {
    const runId = await createReportRunFixture(t);
    const accountId = (
      await createAccountFixture(t, { personId: await createPersonFixture(t, { kind: 'adult' }) })
    ).id;
    const { exportId } = await createExportFixture(t, {
      reportRunId: runId,
      requestedByAccountId: accountId,
      expiresAt: new Date(t.clock.now().getTime() + HOUR),
    });
    const row = await t.db
      .selectFrom('exports')
      .selectAll()
      .where('id', '=', exportId)
      .executeTakeFirstOrThrow();
    await expectPgError(
      t.db
        .updateTable('exports')
        .set({
          status: 'downloaded',
          downloaded_at: row.expires_at,
          downloaded_by: json({ kind: 'staff' }),
        })
        .where('id', '=', exportId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('exports')
        .set({ expires_at: new Date(t.clock.now().getTime() + 48 * HOUR) })
        .where('id', '=', exportId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('exports')
        .set({ authorized_action: 'reporting.export_financial' })
        .where('id', '=', exportId)
        .execute(),
      CHECK,
    );
    await expectPgError(
      t.db
        .updateTable('exports')
        .set({ status: 'revoked', revoked_at: t.clock.now(), revoked_by: json({}) })
        .where('id', '=', exportId)
        .execute(),
      CHECK,
    );
    await t.db
      .updateTable('exports')
      .set({
        status: 'downloaded',
        downloaded_at: t.clock.now(),
        downloaded_by: json({ kind: 'staff' }),
      })
      .where('id', '=', exportId)
      .execute();
    await expectPgError(
      t.db
        .updateTable('exports')
        .set({ status: 'ready', downloaded_at: null, downloaded_by: null })
        .where('id', '=', exportId)
        .execute(),
      CHECK,
    );
    await expectPgError(t.db.deleteFrom('exports').where('id', '=', exportId).execute(), RESTRICT);
    // Token hashes are unique across every organization.
    await expectPgError(
      sql`insert into exports (id, organization_id, report_run_id, report_key, format, authorized_action,
            requested_by, requested_by_account_id, requested_at, expires_at, download_token_hash,
            row_count, content_digest)
          select ${newId()}, organization_id, report_run_id, report_key, format, authorized_action,
            requested_by, requested_by_account_id, requested_at, expires_at, download_token_hash,
            row_count, content_digest
          from exports where id = ${exportId}`.execute(t.db),
      UNIQUE,
    );
    // An export cannot point at another organization's run.
    const otherRun = await createReportRunFixture(t, {
      organizationId: otherOrganizationId,
      facilityId: otherFacilityId,
    });
    await expectPgError(
      t.db
        .insertInto('exports')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          report_run_id: otherRun,
          report_key: 'daily_schedule',
          format: 'csv',
          authorized_action: 'reporting.export_operational',
          requested_by: json({ kind: 'staff' }),
          requested_by_account_id: accountId,
          requested_by_person_id: null,
          requested_at: t.clock.now(),
          expires_at: new Date(t.clock.now().getTime() + HOUR),
          download_token_hash: 'b'.repeat(64),
          row_count: 0,
          content_digest: 'c'.repeat(64),
          downloaded_at: null,
          downloaded_by: null,
          expired_at: null,
          revoked_at: null,
          revoked_by: null,
          revoke_reason: null,
        })
        .execute(),
      FOREIGN_KEY,
    );
    // An expiry must follow the request.
    await expectPgError(
      createExportFixture(t, {
        reportRunId: runId,
        requestedByAccountId: accountId,
        expiresAt: t.clock.now(),
      }),
      CHECK,
    );
  });

  it('SPK-REPORT-004: agreed cost inputs never overlap for one scope and currency, and are immutable facts', async () => {
    const id = await createCostInputFixture(t, {
      amountMinor: 1_000,
      effectiveFrom: '2027-01-01',
      effectiveTo: '2027-07-01',
    });
    await expectPgError(
      createCostInputFixture(t, { amountMinor: 1_200, effectiveFrom: '2027-06-01' }),
      EXCLUSION,
    );
    // Another currency or a later period is a different input.
    await createCostInputFixture(t, {
      amountMinor: 900,
      currency: 'CAD',
      effectiveFrom: '2027-01-01',
    });
    await createCostInputFixture(t, { amountMinor: 1_100, effectiveFrom: '2027-07-01' });
    await expectPgError(
      createCostInputFixture(t, { amountMinor: -1, effectiveFrom: '2028-01-01', currency: 'EUR' }),
      CHECK,
    );
    await expectPgError(
      t.db.updateTable('cost_inputs').set({ amount_minor: 1 }).where('id', '=', id).execute(),
      CHECK,
    );
    await expectPgError(
      t.db.updateTable('cost_inputs').set({ status: 'withdrawn' }).where('id', '=', id).execute(),
      CHECK,
    );
    await t.db
      .updateTable('cost_inputs')
      .set({
        status: 'withdrawn',
        withdrawn_at: t.clock.now(),
        withdrawn_by: json({}),
        withdrawn_reason: 'replaced',
      })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('cost_inputs')
        .set({ status: 'active', withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null })
        .where('id', '=', id)
        .execute(),
      CHECK,
    );
    await expectPgError(t.db.deleteFrom('cost_inputs').where('id', '=', id).execute(), RESTRICT);
    // A withdrawn input no longer blocks an agreed replacement for the same period.
    await createCostInputFixture(t, {
      amountMinor: 1_050,
      effectiveFrom: '2027-01-01',
      effectiveTo: '2027-07-01',
    });
    await expectPgError(
      createCostInputFixture(t, {
        amountMinor: 1,
        effectiveFrom: '2027-01-01',
        facilityId: otherFacilityId,
      }),
      FOREIGN_KEY,
    );
  });

  it('§4.3 / §4.14 (migration 1301): requesters and approvers are accounts and persons of the row’s own organization; a cost input’s space is of its own facility', async () => {
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const account = await createAccountFixture(t, { personId });
    const outsiderId = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: otherOrganizationId,
    });
    const outsider = await createAccountFixture(t, {
      personId: outsiderId,
      organizationId: otherOrganizationId,
    });
    const runId = await createReportRunFixture(t, {
      requestedByAccountId: account.id,
      requestedByPersonId: personId,
    });
    for (const actor of [
      { requestedByAccountId: newId() },
      { requestedByAccountId: outsider.id },
      { requestedByPersonId: outsiderId },
    ]) {
      await expectPgError(createReportRunFixture(t, actor), FOREIGN_KEY);
    }
    // The single-requester binding of an export names an account of its own organization.
    await createExportFixture(t, {
      reportRunId: runId,
      requestedByAccountId: account.id,
      requestedByPersonId: personId,
    });
    for (const actor of [
      { requestedByAccountId: newId() },
      { requestedByAccountId: outsider.id },
      { requestedByAccountId: account.id, requestedByPersonId: outsiderId },
    ]) {
      await expectPgError(createExportFixture(t, { reportRunId: runId, ...actor }), FOREIGN_KEY);
    }
    // A cost input is approved by a person of its organization, for a space of its facility.
    const here = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Keyed pitch',
    });
    const secondFacilityId = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: secondFacilityId,
        organization_id: t.organizationId,
        slug: 'second-site',
        name: 'Second site',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    const there = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: secondFacilityId,
      name: 'Second site pitch',
    });
    const input = { amountMinor: 500, currency: 'GBP', effectiveFrom: '2031-01-01' };
    await createCostInputFixture(t, {
      ...input,
      resourceId: here.resourceId,
      approvedByPersonId: personId,
    });
    await expectPgError(
      createCostInputFixture(t, {
        ...input,
        effectiveFrom: '2032-01-01',
        approvedByPersonId: outsiderId,
      }),
      FOREIGN_KEY,
    );
    await expectPgError(
      createCostInputFixture(t, { ...input, resourceId: there.resourceId }),
      FOREIGN_KEY,
    );
  });

  it('§4.2: reporting views refuse every write — reporting never alters another module’s records', async () => {
    await expectPgError(
      sql`insert into reporting_household_members_v (organization_id, household_id, person_id) values (${t.organizationId}, ${newId()}, ${newId()})`.execute(
        t.db,
      ),
      RESTRICT,
    );
    await t.db
      .insertInto('persons')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        kind: 'adult',
        given_name: 'View',
        family_name: 'Probe',
        date_of_birth: '1990-01-01',
        source: 'staff',
        created_by: json({ kind: 'system' }),
        created_by_person_id: null,
        merged_into_person_id: null,
      })
      .execute();
    await expectPgError(
      sql`update reporting_persons_v set person_status = 'inactive'`.execute(t.db),
      RESTRICT,
    );
    await expectPgError(sql`delete from reporting_persons_v`.execute(t.db), RESTRICT);
    const views = await sql<{ n: number }>`
      select count(*)::int as n from pg_trigger tr
      join pg_class c on c.oid = tr.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v' and c.relname like 'reporting\\_%\\_v' and tr.tgname like '%\\_read_only'
        and n.nspname = current_schema()`.execute(t.db);
    const total = await sql<{ n: number }>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v' and c.relname like 'reporting\\_%\\_v' and n.nspname = current_schema()`.execute(
      t.db,
    );
    expect(views.rows[0]!.n).toBe(total.rows[0]!.n);
    expect(total.rows[0]!.n).toBeGreaterThanOrEqual(40);
  });

  it('§4.6 / SPK-FAC-003: every state a reporting view passes through is typed exactly as its base check lists it (a withdrawn restriction included)', async () => {
    // Every literal-typed column of a `reporting_*_v` view, so a report that switches exhaustively
    // on a typed state never meets an untyped one at runtime. None of the views listed here has a
    // `where` clause (asserted below; their inner joins follow not-null foreign keys), so each
    // passes every base row through and its type is the base check's whole list. The one view that
    // filters, `reporting_resource_status_changes_v` (migration 1302), types its status as text.
    const columns: PassThroughState[] = [
      passThrough('reporting_persons_v', 'person_kind', 'persons', 'kind', {
        adult: true,
        child: true,
      }),
      passThrough('reporting_events_v', 'status', 'events', 'status', {
        draft: true,
        published: true,
        canceled: true,
      }),
      passThrough('reporting_closures_v', 'status', 'closures', 'status', {
        pending: true,
        active: true,
        lifted: true,
        withdrawn: true,
      }),
      passThrough('reporting_reserved_units_v', 'reservation_status', 'reservations', 'status', {
        active: true,
        released: true,
      }),
      passThrough('reporting_sessions_v', 'status', 'offering_sessions', 'status', {
        scheduled: true,
        canceled: true,
        completed: true,
      }),
      passThrough('reporting_acknowledgments_v', 'status', 'acknowledgments', 'status', {
        active: true,
        withdrawn: true,
      }),
      passThrough('reporting_enrollments_v', 'person_kind', 'persons', 'kind', {
        adult: true,
        child: true,
      }),
      passThrough('reporting_enrollments_v', 'status', 'enrollments', 'status', {
        pending: true,
        confirmed: true,
        canceled: true,
        transferred: true,
        completed: true,
      }),
      passThrough('reporting_session_bookings_v', 'person_kind', 'persons', 'kind', {
        adult: true,
        child: true,
      }),
      passThrough('reporting_session_bookings_v', 'status', 'session_bookings', 'status', {
        pending: true,
        confirmed: true,
        canceled: true,
        expired: true,
      }),
      passThrough('reporting_capacity_pools_v', 'status', 'capacity_pools', 'status', {
        active: true,
        closed: true,
      }),
      passThrough('reporting_holds_v', 'status', 'holds', 'status', {
        active: true,
        committed: true,
        released: true,
        expired: true,
      }),
      passThrough('reporting_waitlist_offers_v', 'status', 'waitlist_offers', 'status', {
        offered: true,
        accepted: true,
        expired: true,
        declined: true,
      }),
      passThrough('reporting_team_entries_v', 'status', 'team_entries', 'status', {
        applied: true,
        approved: true,
        withdrawn: true,
        rejected: true,
      }),
      passThrough('reporting_roster_memberships_v', 'person_kind', 'persons', 'kind', {
        adult: true,
        child: true,
      }),
      passThrough(
        'reporting_assignment_requirements_v',
        'target_type',
        'assignment_requirements',
        'target_type',
        {
          fixture: true,
          event: true,
          session: true,
        },
      ),
      passThrough(
        'reporting_attendance_v',
        'activity_type',
        'attendance_observations',
        'activity_type',
        {
          session: true,
          event: true,
        },
      ),
      passThrough(
        'reporting_attendance_v',
        'observed_state',
        'attendance_observations',
        'observed_state',
        {
          present: true,
          absent: true,
          late: true,
          left_early: true,
        },
      ),
      passThrough('reporting_attendance_v', 'source', 'attendance_observations', 'source', {
        online: true,
        offline_sync: true,
      }),
      passThrough(
        'reporting_session_checkins_v',
        'activity_type',
        'session_checkins',
        'activity_type',
        {
          session: true,
          event: true,
        },
      ),
      passThrough('reporting_session_checkins_v', 'status', 'session_checkins', 'status', {
        held: true,
        admitted: true,
        withdrawn: true,
      }),
      passThrough('reporting_visits_v', 'status', 'visits', 'status', {
        on_site: true,
        departed: true,
        voided: true,
      }),
      passThrough('reporting_obligations_v', 'status', 'obligations', 'status', {
        open: true,
        settled: true,
        written_off: true,
        canceled: true,
      }),
      passThrough('reporting_installments_v', 'status', 'installments', 'status', {
        scheduled: true,
        paid: true,
        failed: true,
        canceled: true,
      }),
      passThrough('reporting_settlements_v', 'status', 'settlement_reconciliations', 'status', {
        balanced: true,
        discrepancy: true,
      }),
      passThrough('reporting_restrictions_v', 'kind', 'restrictions', 'kind', {
        closed: true,
        limited: true,
      }),
      passThrough('reporting_restrictions_v', 'status', 'restrictions', 'status', {
        proposed: true,
        approved: true,
        active: true,
        released: true,
        withdrawn: true,
      }),
      passThrough('reporting_maintenance_tasks_v', 'severity', 'maintenance_tasks', 'severity', {
        low: true,
        medium: true,
        high: true,
        critical: true,
      }),
      passThrough('reporting_maintenance_tasks_v', 'status', 'maintenance_tasks', 'status', {
        open: true,
        assigned: true,
        in_progress: true,
        resolved: true,
        closed: true,
      }),
      passThrough('reporting_notifications_v', 'category', 'notifications', 'category', {
        operational: true,
        promotional: true,
      }),
      passThrough('reporting_delivery_attempts_v', 'category', 'notifications', 'category', {
        operational: true,
        promotional: true,
      }),
      passThrough(
        'reporting_notification_recipients_v',
        'status',
        'notification_recipients',
        'status',
        {
          pending: true,
          authorized: true,
          revoked: true,
        },
      ),
    ];
    const allowed = async (table: string, column: string): Promise<string[]> => {
      const { rows } = await sql<{ def: string }>`
        select pg_get_constraintdef(con.oid) as def from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        where con.contype = 'c' and c.relname = ${table} and n.nspname = current_schema()`.execute(
        t.db,
      );
      const lists = rows.flatMap(({ def }) => {
        const match =
          /^CHECK \(\(\(?(\w+)\)?(?:::text)? = ANY \(\(?ARRAY\[(.+)\]\)?(?:::text\[\])?\)\)\)$/.exec(
            def,
          );
        return match && match[1] === column
          ? [[...match[2]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()]
          : [];
      });
      expect(lists, `${table}.${column} has exactly one state check constraint`).toHaveLength(1);
      return lists[0]!;
    };
    const definition = async (view: string): Promise<string> => {
      const { rows } = await sql<{ def: string }>`
        select pg_get_viewdef(c.oid) as def from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'v' and c.relname = ${view} and n.nspname = current_schema()`.execute(
        t.db,
      );
      expect(rows, `${view} exists`).toHaveLength(1);
      return rows[0]!.def;
    };
    // The detector sees a filtering view: the status-change view keeps only audited changes.
    expect(await definition('reporting_resource_status_changes_v')).toMatch(/\bWHERE\b/);
    for (const c of columns) {
      expect(await definition(c.view), `${c.view} does not filter its rows`).not.toMatch(
        /\bWHERE\b/,
      );
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from information_schema.view_column_usage
        where view_schema = current_schema() and view_name = ${c.view}
          and table_name = ${c.table} and column_name = ${c.baseColumn}`.execute(t.db);
      expect(rows[0]!.n, `${c.view} reads ${c.table}.${c.baseColumn}`).toBe(1);
      expect(
        c.typed,
        `${c.view}.${c.column} is typed as ${c.table}.${c.baseColumn} allows`,
      ).toEqual(await allowed(c.table, c.baseColumn));
    }
  });
});
