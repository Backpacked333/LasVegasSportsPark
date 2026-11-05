import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createAuthorityAssignmentFixture,
  createExternalMappingFixture,
  stagedCredit,
  stagedObligation,
  stagedPerson,
  stagedRelationship,
} from '../testing/migration-fixtures';
import { createPersonFixture } from '../../identity';
import {
  get,
  grantLegacyAuthority,
  importSnapshot,
  migrationTestApp,
  post,
  stageAndValidate,
  stageBody,
  staff,
  type Actor,
} from './support';

/**
 * MIG-01 (§5.4, §5.5, §4.5, SCR-S-50 to SCR-S-55): the batch names its latest reconciliation
 * report and lists the earlier ones, an exception about a balance states the staged amount and
 * its currency, and the four migration lists page with a cursor (created_at desc, id desc).
 */
describe('batch views and paging (MIG-01)', () => {
  let t: TestApp;
  let operator: Actor;

  beforeAll(async () => {
    t = await migrationTestApp();
    operator = await staff(t, ['general_manager']);
    await grantLegacyAuthority(t);
  });
  afterAll(async () => {
    await t.close();
  });

  /** Every item of a paged list, following nextCursor; asserts the pages never overlap. */
  async function allPages(path: string, limit: number) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const url: string = `${path}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(t, url, operator);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const items = res.body.items as Array<{ id: string; createdAt: string }>;
      expect(items.length).toBeLessThanOrEqual(limit);
      ids.push(...items.map((i) => i.id));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor && pages < 50);
    expect(new Set(ids).size).toBe(ids.length);
    return { ids, pages };
  }

  it('§5.5: earlier reconciliation reports are listed from the batch and the batch names the latest', async () => {
    const applied = await importSnapshot(t, operator, [stagedPerson('RL-1')], {
      sourceSystem: 'legacy-latest',
    });
    const before = await get(t, `/v1/import-batches/${applied.id}`, operator);
    expect(before.body.latestReconciliationReportId).toBeNull();
    const empty = await get(t, `/v1/import-batches/${applied.id}/reconciliation-reports`, operator);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });
    const first = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(
      (await get(t, `/v1/import-batches/${applied.id}`, operator)).body
        .latestReconciliationReportId,
    ).toBe(first.body.id);
    t.clock.advance(1_000);
    const second = await post(
      t,
      `/v1/import-batches/${applied.id}/reconciliation-reports`,
      operator,
      {},
    );
    expect(second.status).toBe(201);
    const batch = await get(t, `/v1/import-batches/${applied.id}`, operator);
    expect(batch.body.latestReconciliationReportId).toBe(second.body.id);
    const list = await get(t, `/v1/import-batches/${applied.id}/reconciliation-reports`, operator);
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([
      second.body.id,
      first.body.id,
    ]);
    expect(list.body.items[1]).toMatchObject({
      approvalStatus: 'superseded',
      supersededByReportId: second.body.id,
    });
    // The batch list carries the same field.
    const listed = await get(t, '/v1/import-batches?sourceSystem=legacy-latest', operator);
    expect(listed.body.items[0]).toMatchObject({
      id: applied.id,
      latestReconciliationReportId: second.body.id,
    });
  });

  it('an import exception about a balance states its currency', async () => {
    const validated = await stageAndValidate(
      t,
      operator,
      [
        stagedPerson('CUR-P1'),
        stagedPerson('CUR-P2', { kind: 'child', dateOfBirth: '2016-05-01' }),
        stagedObligation('CUR-OB', {
          debtorExternalId: 'CUR-P1',
          amountMinor: 12_345,
          currency: 'CAD',
          disputed: true,
        }),
        stagedCredit('CUR-CR', { ownerExternalId: 'CUR-P1', amountMinor: -250, currency: 'USD' }),
        stagedRelationship('CUR-REL', {
          actorExternalId: 'CUR-P1',
          subjectExternalId: 'CUR-P2',
          basis: 'inferred',
        }),
      ],
      { sourceSystem: 'legacy-currency' },
    );
    const res = await get(t, `/v1/import-exceptions?batchId=${validated.id}&limit=50`, operator);
    expect(res.status).toBe(200);
    const byExternal = new Map(
      (
        res.body.items as Array<{
          externalId: string;
          kind: string;
          stagedAmountMinor: number | null;
          currency: string | null;
        }>
      ).map((e) => [e.externalId, e]),
    );
    expect(byExternal.get('CUR-OB')).toMatchObject({
      kind: 'ambiguous_balance',
      stagedAmountMinor: 12_345,
      currency: 'CAD',
    });
    expect(byExternal.get('CUR-CR')).toMatchObject({
      kind: 'ambiguous_balance',
      stagedAmountMinor: -250,
      currency: 'USD',
    });
    // Not a balance: no amount, no currency.
    expect(byExternal.get('CUR-REL')).toMatchObject({
      kind: 'ambiguous_relationship',
      stagedAmountMinor: null,
      currency: null,
    });
    // A decision answers with the same view.
    const finance = await staff(t, ['finance_operator']);
    const exception = res.body.items.find((e: { externalId: string }) => e.externalId === 'CUR-OB');
    const decided = await post(t, `/v1/import-exceptions/${exception.id}/decide`, finance, {
      decision: 'defer',
      reason: 'Waiting for the disputed invoice',
      expectedRevision: exception.revision,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toMatchObject({ stagedAmountMinor: 12_345, currency: 'CAD' });
  });

  it('MIG-01: import batches, import exceptions, authority assignments and external mappings page with a cursor, newest first', async () => {
    // Batches: five more staged batches of one source.
    for (let i = 0; i < 5; i += 1) {
      const staged = await post(
        t,
        '/v1/import-batches',
        operator,
        stageBody([stagedPerson(`PG-${i}`)], { sourceSystem: 'legacy-paging' }),
      );
      expect(staged.status, JSON.stringify(staged.body)).toBe(201);
    }
    const batches = await allPages('/v1/import-batches?sourceSystem=legacy-paging', 2);
    expect(batches.ids).toHaveLength(5);
    expect(batches.pages).toBe(3);
    const full = await get(t, '/v1/import-batches?sourceSystem=legacy-paging&limit=50', operator);
    expect(batches.ids).toEqual(full.body.items.map((b: { id: string }) => b.id));
    const created = full.body.items.map((b: { createdAt: string }) => b.createdAt);
    expect([...created].sort().reverse()).toEqual(created);

    // Exceptions: a batch with several validation exceptions.
    const invalid = await stageAndValidate(
      t,
      operator,
      [0, 1, 2, 3, 4].map((i) => ({
        entityType: 'person' as const,
        externalId: `PG-BAD-${i}`,
        payload: { familyName: 'No given name' },
      })),
      { sourceSystem: 'legacy-paging-invalid' },
    );
    const exceptions = await allPages(`/v1/import-exceptions?batchId=${invalid.id}`, 2);
    expect(exceptions.ids).toHaveLength(5);

    // Authority assignments: the four categories granted in beforeAll plus three more.
    for (const recordCategory of ['season', 'team', 'roster'] as const) {
      await createAuthorityAssignmentFixture(t, { recordCategory, authoritativeSystem: 'legacy' });
    }
    const assignments = await allPages('/v1/authority-assignments', 3);
    const allAssignments = await get(t, '/v1/authority-assignments?limit=200', operator);
    expect(assignments.ids).toEqual(allAssignments.body.items.map((a: { id: string }) => a.id));
    expect(assignments.ids.length).toBeGreaterThanOrEqual(9);

    // External mappings: five linked mappings of one source.
    for (let i = 0; i < 5; i += 1) {
      const personId = await createPersonFixture(t, { kind: 'adult' });
      await createExternalMappingFixture(t, {
        entityType: 'person',
        externalId: `PG-MAP-${i}`,
        internalId: personId,
        sourceSystem: 'legacy-paging-map',
      });
    }
    const mappings = await allPages('/v1/external-mappings?sourceSystem=legacy-paging-map', 2);
    expect(mappings.ids).toHaveLength(5);

    // An unreadable cursor is refused, never silently restarted.
    const bad = await get(t, '/v1/import-batches?cursor=not-a-cursor', operator);
    expect(bad.status).toBe(400);
  });
});
