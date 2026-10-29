import type { TestingModuleBuilder } from '@nestjs/testing';
import { DomainError, decodeCursor, encodeCursor, z } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { DATABASE, currentTransaction, type Trx } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { CashTendersService } from '../../finance';
import { PERSON_DIRECTORY_PORT, PeopleService } from '../../identity';

/**
 * Test doubles for stage-3 members declared on the core branch and implemented by other modules'
 * work items: ID-01 (`PersonDirectoryPort.personIdsResolvingTo`, IF-09) and FIN-02
 * (`CashTendersService.listForPersons`). Each double answers through the declared contract only
 * while the real member is absent or still `declaredNotImplemented`, so once the owning work item
 * is merged these tests exercise the real implementation unchanged. Test infrastructure only:
 * production code calls the members as declared.
 */

function isDeclaredNotImplemented(error: unknown): boolean {
  return (
    DomainError.is(error) &&
    error.code === 'INTERNAL_ERROR' &&
    /declared but not implemented/.test(error.message)
  );
}

/** IF-09 (ID-01): `[canonical, ...merged into it]` from identity's own merge links. */
export function withStage3Doubles(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(PERSON_DIRECTORY_PORT).useFactory({
    inject: [PeopleService, DATABASE],
    factory: (people: PeopleService, db: Db) => {
      const port = Object.create(people) as PeopleService;
      port.personIdsResolvingTo = async (organizationId, personId, trx) => {
        try {
          return await people.personIdsResolvingTo(organizationId, personId, trx);
        } catch (error) {
          if (!isDeclaredNotImplemented(error)) throw error;
        }
        if (!(await people.findPerson(organizationId, personId, trx))) return [];
        const reader: Db | Trx = trx ?? currentTransaction() ?? db;
        const canonical = await people.resolveCanonicalPersonId(organizationId, personId, trx);
        const merged = await reader
          .selectFrom('persons')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('merged_into_person_id', 'is not', null)
          .orderBy('id')
          .execute();
        const ids: string[] = [];
        for (const row of merged) {
          if ((await people.resolveCanonicalPersonId(organizationId, row.id, trx)) === canonical) {
            ids.push(row.id);
          }
        }
        return [canonical, ...ids];
      };
      return port;
    },
  });
}

const TenderCursor = z.object({ at: z.string(), id: z.uuid() });

/**
 * FIN-02: `CashTendersService.listForPersons` (finance's in-process read of the tenders people
 * paid, newest first on (recorded_at, id)), installed on the service instance only when the
 * real member is absent.
 */
export function installCashTenderDouble(t: TestApp): void {
  const service = t.app.get(CashTendersService) as unknown as Record<string, unknown>;
  if (typeof service['listForPersons'] === 'function') return;
  service['listForPersons'] = async (
    organizationId: string,
    personIds: readonly string[],
    page: { cursor?: string; limit: number },
  ) => {
    if (personIds.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCursor(page.cursor, TenderCursor);
    let q = (currentTransaction() ?? t.db)
      .selectFrom('cash_tenders')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('payer_person_id', 'in', [...personIds])
      .orderBy('recorded_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit + 1);
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('recorded_at', '<', at),
          eb.and([eb('recorded_at', '=', at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q.execute();
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((row) => ({
        id: row.id,
        facilityId: row.facility_id,
        tenderKind: row.tender_kind,
        payerPersonId: row.payer_person_id,
        amountMinor: row.amount_minor,
        currency: row.currency,
        obligationId: row.obligation_id,
        checkoutId: row.checkout_id,
        recordedByPersonId: row.recorded_by_person_id,
        recordedAt: new Date(row.recorded_at).toISOString(),
        status: row.status,
        reconciliationId: row.reconciliation_id,
      })),
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ at: new Date(last.recorded_at).toISOString(), id: last.id })
          : null,
    };
  };
}
