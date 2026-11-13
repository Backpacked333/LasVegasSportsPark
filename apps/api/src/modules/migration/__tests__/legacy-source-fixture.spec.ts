import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import type { TestApp } from '../../../testing';
import {
  LEGACY_SOURCE_ODDITIES,
  legacyInvoiceTotalCents,
  legacySourceFixture,
  legacySourceToStaging,
  type LegacySourceFixture,
} from '../testing/legacy-source-fixture';
import {
  countRows,
  exceptionsOf,
  get,
  grantLegacyAuthority,
  migrationTestApp,
  post,
  rowsOf,
  staff,
  stageAndValidate,
  type Actor,
} from './support';

const DUE_AT = '2027-02-01T00:00:00.000Z';
const KINDS = [
  'customers',
  'familyLinks',
  'products',
  'seasons',
  'levels',
  'teams',
  'rosterEntries',
  'invoices',
  'credits',
] as const satisfies readonly (keyof LegacySourceFixture)[];

describe('§5.3: the synthetic source-shaped fixture', () => {
  const source = legacySourceFixture();
  const ids = <K extends keyof LegacySourceFixture>(kind: K): string[] =>
    source[kind].map((record) => record.id);

  it('§5.3: ids are unique within each record kind and every reference resolves', () => {
    for (const kind of KINDS) expect(new Set(ids(kind)).size, kind).toBe(source[kind].length);
    const customers = new Set(ids('customers'));
    const products = new Set(ids('products'));
    const seasons = new Set(ids('seasons'));
    const levels = new Set(ids('levels'));
    const teams = new Set(ids('teams'));
    for (const link of source.familyLinks) {
      expect(customers.has(link.customerId), link.id).toBe(true);
      expect(customers.has(link.relatedCustomerId), link.id).toBe(true);
    }
    for (const level of source.levels) expect(seasons.has(level.seasonId), level.id).toBe(true);
    for (const team of source.teams) expect(levels.has(team.levelId), team.id).toBe(true);
    for (const entry of source.rosterEntries) {
      expect(teams.has(entry.teamId), entry.id).toBe(true);
      expect(customers.has(entry.customerId), entry.id).toBe(true);
    }
    for (const invoice of source.invoices) {
      expect(customers.has(invoice.customerId), invoice.id).toBe(true);
      for (const item of invoice.items) {
        if (item.productId) expect(products.has(item.productId), invoice.id).toBe(true);
      }
    }
    for (const credit of source.credits) {
      expect(customers.has(credit.customerId), credit.id).toBe(true);
    }
  });

  it('§5.3: contact values are synthetic (reserved .test domain and 555-01xx numbers)', () => {
    for (const customer of source.customers) {
      if (customer.email) expect(customer.email).toMatch(/@example\.test$/i);
      if (customer.phone) expect(customer.phone).toMatch(/^\(702\) 555-01\d\d$/);
    }
  });

  it('§5.3: the manifest names every oddity and the data holds it', () => {
    const customer = new Map(source.customers.map((c) => [c.id, c]));
    const identity = (id: string) => {
      const c = customer.get(id);
      return `${c?.firstName}|${c?.lastName}|${c?.birthDate}`;
    };
    for (const [a, b] of LEGACY_SOURCE_ODDITIES.duplicateCustomers) {
      expect(identity(a)).toBe(identity(b));
      expect(customer.get(a)?.email?.toLowerCase()).toBe(customer.get(b)?.email?.toLowerCase());
      expect(customer.get(a)?.email).not.toBe(customer.get(b)?.email);
    }
    for (const [a, b] of LEGACY_SOURCE_ODDITIES.namesakes) {
      expect(customer.get(a)?.lastName).toBe(customer.get(b)?.lastName);
      expect(customer.get(a)?.firstName).toBe(customer.get(b)?.firstName);
      expect(customer.get(a)?.birthDate).not.toBe(customer.get(b)?.birthDate);
    }
    expect(source.customers.filter((c) => !c.birthDate).map((c) => c.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.customersWithoutBirthDate,
    ]);
    expect(source.customers.filter((c) => c.paperWaiverOn).map((c) => c.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.paperWaiverCustomers,
    ]);
    const currentWaiver = Math.max(...source.customers.map((c) => c.waiver?.version ?? 0));
    expect(
      source.customers.filter((c) => c.waiver && c.waiver.version < currentWaiver).map((c) => c.id),
    ).toEqual([...LEGACY_SOURCE_ODDITIES.staleWaiverCustomers]);
    // Open amounts are 1.00 products; discounts and refunds are negative products.
    expect(source.products.filter((p) => p.priceCents === 100).map((p) => p.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.openAmountProducts,
    ]);
    expect(source.products.filter((p) => p.priceCents < 0).map((p) => p.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.negativeProducts,
    ]);
    expect(source.seasons.filter((s) => /waiver list/i.test(s.name)).map((s) => s.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.rentalWaiverListSeasons,
    ]);
    expect(source.seasons.filter((s) => /waiting list/i.test(s.name)).map((s) => s.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.waitingListSeasons,
    ]);
    expect(
      source.levels.filter((l) => l.priceCents === 0 && /^Group /.test(l.name)).map((l) => l.id),
    ).toEqual([...LEGACY_SOURCE_ODDITIES.zeroPriceTournamentLevels]);
    expect(source.teams.filter((t) => /individual player/i.test(t.name)).map((t) => t.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.jerseyBucketTeams,
    ]);
    expect(source.invoices.filter((i) => legacyInvoiceTotalCents(i) < 0).map((i) => i.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.negativeInvoices,
    ]);
    const inactive = new Set(source.customers.filter((c) => !c.active).map((c) => c.id));
    expect(source.credits.filter((c) => inactive.has(c.customerId)).map((c) => c.id)).toEqual([
      ...LEGACY_SOURCE_ODDITIES.creditsOnInactiveCustomers,
    ]);
  });

  it('SPK-PAY-001: invoice arithmetic is exact in cents, including 1.00 x quantity and negative lines', () => {
    const totals = Object.fromEntries(
      source.invoices.map((i) => [i.id, [legacyInvoiceTotalCents(i), i.paidCents]]),
    );
    expect(totals).toEqual({
      I7001: [46_500, 46_500],
      I7002: [60_000, 20_000],
      I7003: [-20_000, -20_000],
      I7004: [85_000, 0],
      I5120: [1_500, 1_500],
    });
    for (const invoice of source.invoices) {
      const settled = legacyInvoiceTotalCents(invoice) === invoice.paidCents;
      expect(invoice.status, invoice.id).toBe(settled ? 'paid' : 'open');
    }
  });

  it('§5.4: the staging transformation accounts for every source record and keeps the money', () => {
    const { rows, unmapped } = legacySourceToStaging(source, { dueAt: DUE_AT });
    expect(new Set(rows.map((r) => `${r.entityType}|${r.externalId}`)).size).toBe(rows.length);
    const staged = JSON.stringify(rows);
    for (const kind of ['customers', 'invoices', 'credits'] as const) {
      const prefix = { customers: 'customer', invoices: 'invoice', credits: 'credit' }[kind];
      for (const id of ids(kind)) expect(staged, `${kind} ${id}`).toContain(`"${prefix}:${id}"`);
    }
    const unmappedIds = new Set(unmapped.map((u) => `${u.kind}|${u.id}`));
    for (const link of source.familyLinks) {
      const carried = staged.includes(`"family-link:${link.id}"`);
      expect(carried !== unmappedIds.has(`familyLinks|${link.id}`), link.id).toBe(true);
    }
    for (const kind of ['products', 'seasons', 'levels', 'teams', 'rosterEntries'] as const) {
      for (const id of ids(kind))
        expect(unmappedIds.has(`${kind}|${id}`), `${kind} ${id}`).toBe(true);
    }
    for (const record of unmapped) expect(record.reason.length).toBeGreaterThan(20);

    const sum = (entityType: string, field: string): number =>
      rows
        .filter((r) => r.entityType === entityType)
        .reduce((total, r) => total + Number(r.payload[field]), 0);
    const invoiced = source.invoices.reduce((t, i) => t + legacyInvoiceTotalCents(i), 0);
    const paid = source.invoices.reduce((t, i) => t + i.paidCents, 0);
    expect(sum('order', 'totalMinor')).toBe(invoiced);
    expect(sum('open_obligation', 'amountMinor')).toBe(invoiced - paid);
    expect(sum('credit', 'amountMinor')).toBe(
      source.credits.reduce((t, c) => t + c.remainingCents, 0),
    );
  });
});

describe('SPK-AT-024: the source-shaped fixture imported twice', () => {
  const source = legacySourceFixture();
  const { rows } = legacySourceToStaging(source, { dueAt: DUE_AT });
  let t: TestApp;
  let operator: Actor;
  let first: AppliedBatch;

  interface AppliedBatch {
    id: string;
    status: string;
    checksum: string;
    outcomeCounts: Record<string, number>;
  }

  /**
   * Stage, validate, reject the one row that cannot be applied, review and apply. The spent
   * credit of an inactive customer is the only exception the fixture raises.
   */
  const importFixture = async (): Promise<AppliedBatch> => {
    const validated = await stageAndValidate(t, operator, rows);
    const open = await exceptionsOf(t, operator, validated.id);
    expect(open.map((e) => [e.externalId, e.kind, e.reasons.map((r) => r.code)])).toEqual([
      ['credit:K3', 'validation', ['reference_inactive']],
    ]);
    for (const exception of open) {
      const decided = await post(t, `/v1/import-exceptions/${exception.id}/decide`, operator, {
        decision: 'reject',
        reason: 'Spent credit of an inactive customer; nothing to carry over.',
        expectedRevision: exception.revision,
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    }
    const current = await get(t, `/v1/import-batches/${validated.id}`, operator);
    const reviewed = await post(t, `/v1/import-batches/${validated.id}/review`, operator, {
      expectedRevision: current.body.revision,
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const applied = await post(t, `/v1/import-batches/${validated.id}/apply`, operator, {});
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    return applied.body as AppliedBatch;
  };

  const balances = async () => {
    const obligations = await t.db
      .selectFrom('obligations')
      .select(['amount_minor', 'currency', 'status'])
      .where('organization_id', '=', t.organizationId)
      .execute();
    const credits = await t.db
      .selectFrom('credits')
      .select(['remaining_minor', 'currency'])
      .where('organization_id', '=', t.organizationId)
      .execute();
    return {
      persons: await countRows(t, 'persons'),
      households: await countRows(t, 'households'),
      relationships: await countRows(t, 'relationships'),
      owedMinor: obligations.reduce((sum, o) => sum + Number(o.amount_minor), 0),
      obligations: obligations.length,
      creditMinor: credits.reduce((sum, c) => sum + Number(c.remaining_minor), 0),
      credits: credits.length,
      paymentAttempts: await countRows(t, 'payment_attempts'),
      notifications: await countRows(t, 'notifications'),
    };
  };

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['general_manager']);
    await grantLegacyAuthority(t);
    first = await importFixture();
    await t.app.get(OutboxDispatcher).runOnce(500);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-AT-024 / §5.4: every staged row ends created, or skipped with a reason; none is left an exception', async () => {
    expect(first.status).toBe('applied');
    const imported = await rowsOf(t, operator, first.id);
    expect(imported).toHaveLength(rows.length);
    const outcome = new Map(imported.map((r) => [r.externalId, r]));
    for (const row of imported) {
      expect(['created', 'skipped'], row.externalId).toContain(row.outcome);
      if (row.outcome === 'skipped') expect(row.reasons.length, row.externalId).toBeGreaterThan(0);
      else expect(row.internalId, row.externalId).toBeTruthy();
    }
    // Invoices and waivers are history: retained on the staged row, never replayed (§5.4).
    for (const invoice of source.invoices) {
      expect(outcome.get(`invoice:${invoice.id}`)?.reasons.map((r) => r.code)).toEqual([
        'retained_as_history',
      ]);
    }
    expect(outcome.get('waiver:1003:paper')?.reasons.map((r) => r.code)).toEqual([
      'retained_as_history',
    ]);
    expect(outcome.get('credit:K3')?.reasons.map((r) => r.code)).toEqual(['review_rejected']);
  });

  it('SPK-AT-024 / §5.5: opening balances equal the source to the cent and nothing is charged or sent', async () => {
    const invoiced = source.invoices.reduce((sum, i) => sum + legacyInvoiceTotalCents(i), 0);
    const paid = source.invoices.reduce((sum, i) => sum + i.paidCents, 0);
    expect(await balances()).toEqual({
      persons: source.customers.length + 1, // plus the operator
      households: 1,
      relationships: 2,
      owedMinor: invoiced - paid,
      obligations: 2,
      creditMinor: 7_500,
      credits: 2,
      paymentAttempts: 0,
      notifications: 0,
    });
    expect(invoiced - paid).toBe(125_000);
  });

  it('§5.5: reconciliation finds no unexplained difference; the rejected row is reported with its reason', async () => {
    const report = await post(
      t,
      `/v1/import-batches/${first.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    // The one row rejected in review is listed with who decided and why; no money differs.
    const discrepancies = report.body.discrepancies as Array<Record<string, unknown>>;
    expect(
      discrepancies.map((d) => [d['level'], d['code'], d['externalId'], d['differenceMinor']]),
    ).toEqual([['record_identity', 'rejected_in_review', 'credit:K3', 0]]);
    for (const level of ['control_totals', 'relationships', 'operational_outcomes']) {
      expect(report.body.levels.find((l: { level: string }) => l.level === level)).toMatchObject({
        status: 'balanced',
        discrepancyCount: 0,
      });
    }
  });

  it('SPK-AT-024: the same fixture imported again creates nothing and changes no total', async () => {
    const before = await balances();
    const second = await importFixture();
    await t.app.get(OutboxDispatcher).runOnce(500);
    expect(second.checksum).toBe(first.checksum);
    expect(second.outcomeCounts).toMatchObject({ created: 0, updated: 0, exception: 0 });
    expect(second.outcomeCounts['matched']).toBe(first.outcomeCounts['created']);
    expect(second.outcomeCounts['skipped']).toBe(first.outcomeCounts['skipped']);
    expect(await balances()).toEqual(before);
  });

  it('§5.3 (recorded gap, DEC-014): one person held as two customer records is imported as two people', async () => {
    // No identity resolution exists yet: the duplicate pair stays two people, and the team fee
    // recorded on the second record is owed by that second person. Merging is an operator
    // decision (questionnaire M6), so this asserts today's behaviour, not the intended one.
    const imported = await rowsOf(t, operator, first.id);
    const internal = new Map(imported.map((r) => [r.externalId, r.internalId]));
    for (const [a, b] of LEGACY_SOURCE_ODDITIES.duplicateCustomers) {
      expect(internal.get(`customer:${a}`)).toBeTruthy();
      expect(internal.get(`customer:${a}`)).not.toBe(internal.get(`customer:${b}`));
    }
  });
});
