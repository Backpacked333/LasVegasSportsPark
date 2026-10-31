import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import { DATABASE, executorFor, type Trx } from '../../../kernel';
// The port is entry's (IF-39); its declaration file holds only the interface and its tokens, and
// is imported directly because entry's module imports finance (an index import would be a cycle).
import type { FinancialStanding, FinancialStandingPort } from '../../entry/entry.ports';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { personIdsOf } from './customer-scope';

/**
 * A participant's financial standing at arrival (FIN-03, IF-39; SPK-ENTRY-004, POL-017, DEC-056),
 * registered as entry's FINANCIAL_STANDING_IMPL. Reads through the given or the active transaction,
 * organization-scoped, the open obligations due by `at` of the person (and of everyone merged into
 * them, ID-01): those they owe or are the responsible payer of, and those of the orders that
 * registered them as a participant (a parent's unpaid fee for the child's own registration).
 *
 * - none: `clear`;
 * - otherwise `outstanding` with the earliest-due obligation's remaining amount, currency and id,
 *   preferring one whose order line is for the activity's offering (`related: true`);
 * - a failed read: `unknown` with an explanation (never a guess).
 *
 * Finance reports facts only: whether an unrelated (or a related) balance blocks arrival is entry's
 * decision from the approved policy (POL-017 / DEC-056 pending: informational by default).
 */
@Injectable()
export class FinancialStandingService implements FinancialStandingPort {
  private readonly logger = new Logger(FinancialStandingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  async standingOf(
    organizationId: string,
    personId: string,
    context: { offeringId: string | null; at: Date },
    trx?: Trx,
  ): Promise<FinancialStanding> {
    try {
      return await this.read(organizationId, personId, context, trx);
    } catch (error) {
      this.logger.warn(`financial standing of ${personId} could not be read: ${String(error)}`);
      return {
        status: 'unknown',
        explanation: 'The financial standing could not be read; nothing is asserted about it.',
      };
    }
  }

  private async read(
    organizationId: string,
    personId: string,
    context: { offeringId: string | null; at: Date },
    trx?: Trx,
  ): Promise<FinancialStanding> {
    const db = trx ?? executorFor(this.db);
    const ids = await personIdsOf(this.persons, organizationId, personId, trx);
    const participantOrders = db
      .selectFrom('order_lines')
      .select('order_id')
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', 'in', ids);
    const due = await db
      .selectFrom('obligations')
      .select(['id', 'order_id', 'amount_minor', 'allocated_minor', 'currency', 'due_at'])
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'open')
      .where('due_at', '<=', context.at)
      .where((eb) =>
        eb.or([
          eb('debtor_person_id', 'in', ids),
          eb('responsible_payer_person_id', 'in', ids),
          eb('order_id', 'in', participantOrders),
        ]),
      )
      .orderBy('due_at')
      .orderBy('id')
      .execute();
    if (due.length === 0) return { status: 'clear' };
    let related = new Set<string>();
    const orderIds = [...new Set(due.map((o) => o.order_id).filter((id): id is string => !!id))];
    if (context.offeringId && orderIds.length > 0) {
      const lines = await db
        .selectFrom('order_lines')
        .select('order_id')
        .where('organization_id', '=', organizationId)
        .where('order_id', 'in', orderIds)
        .where('participant_person_id', 'in', ids)
        .where('offering_id', '=', context.offeringId)
        .execute();
      related = new Set(lines.map((l) => l.order_id));
    }
    const first =
      due.find((o) => o.order_id !== null && related.has(o.order_id)) ??
      (due[0] as (typeof due)[number]);
    return {
      status: 'outstanding',
      related: first.order_id !== null && related.has(first.order_id),
      amountMinor: Number(first.amount_minor) - Number(first.allocated_minor),
      currency: first.currency,
      reference: first.id,
    };
  }
}
