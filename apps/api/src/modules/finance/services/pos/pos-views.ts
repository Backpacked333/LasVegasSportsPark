import type {
  PosProduct,
  PosReceipt,
  PosRegister,
  PosRegisterSession,
  PosReturn,
  PosSale,
  PosSaleLine,
  PosTender,
} from '@sportspark/contracts';
import type {
  PosLineChargeRecord,
  PosProductsTable,
  PosRegisterSessionsTable,
  PosRegistersTable,
  PosReturnLineRecord,
  PosReturnsTable,
  PosSaleLinesTable,
  PosTendersTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import { iso, isoOrNull, type Reader } from '../../finance.shared';
import type { PosSaleRow } from './pos-sale-finalizer.service';

export type PosProductRow = Selectable<PosProductsTable>;
export type PosRegisterRow = Selectable<PosRegistersTable>;
export type PosSessionRow = Selectable<PosRegisterSessionsTable>;
export type PosSaleLineRow = Selectable<PosSaleLinesTable>;
export type PosTenderRow = Selectable<PosTendersTable>;
export type PosReturnRow = Selectable<PosReturnsTable>;

export const PAID_SALE_STATES = ['paid', 'partially_returned', 'returned'] as const;

export function toPosProduct(row: PosProductRow, chargeKeys: string[]): PosProduct {
  return {
    id: row.id,
    facilityId: row.facility_id,
    sku: row.sku,
    name: row.name,
    kind: row.kind,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    chargePolicyKeys: chargeKeys,
    status: row.status,
    retiredAt: isoOrNull(row.retired_at),
    retireReason: row.retire_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toPosRegister(row: PosRegisterRow, openSessionId: string | null): PosRegister {
  return {
    id: row.id,
    facilityId: row.facility_id,
    code: row.code,
    name: row.name,
    status: row.status,
    openSessionId,
    retiredAt: isoOrNull(row.retired_at),
    retireReason: row.retire_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

/**
 * The cash a session's drawer should hold (POL-018 pending, no tolerance): the opening float plus
 * the settled cash tenders of its sales that were not voided (a void hands its cash back) minus
 * the cash returns paid from this drawer.
 */
export async function expectedCash(db: Reader, session: PosSessionRow): Promise<number> {
  const tenders = await db
    .selectFrom('pos_tenders')
    .innerJoin('pos_sales', (join) =>
      join
        .onRef('pos_sales.id', '=', 'pos_tenders.sale_id')
        .onRef('pos_sales.organization_id', '=', 'pos_tenders.organization_id'),
    )
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<number>('pos_tenders.amount_minor'), eb.lit(0)).as('total'),
    )
    .where('pos_tenders.organization_id', '=', session.organization_id)
    .where('pos_sales.register_session_id', '=', session.id)
    .where('pos_sales.status', '<>', 'voided')
    .where('pos_tenders.kind', '=', 'cash')
    .where('pos_tenders.status', '=', 'settled')
    .executeTakeFirst();
  const returns = await db
    .selectFrom('pos_returns')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_minor'), eb.lit(0)).as('total'))
    .where('organization_id', '=', session.organization_id)
    .where('register_session_id', '=', session.id)
    .where('tender_kind', '=', 'cash')
    .executeTakeFirst();
  return (
    Number(session.opening_float_minor) + Number(tenders?.total ?? 0) - Number(returns?.total ?? 0)
  );
}

export async function toPosSession(db: Reader, row: PosSessionRow): Promise<PosRegisterSession> {
  return {
    id: row.id,
    registerId: row.register_id,
    facilityId: row.facility_id,
    currency: row.currency,
    businessDate: row.business_date,
    openingFloatMinor: Number(row.opening_float_minor),
    openedByPersonId: row.opened_by_person_id,
    openedAt: iso(row.opened_at),
    status: row.status,
    expectedCashMinor:
      row.expected_cash_minor !== null
        ? Number(row.expected_cash_minor)
        : await expectedCash(db, row),
    countedCashMinor: row.counted_cash_minor !== null ? Number(row.counted_cash_minor) : null,
    varianceMinor: row.variance_minor !== null ? Number(row.variance_minor) : null,
    closedByPersonId: row.closed_by_person_id,
    closedAt: isoOrNull(row.closed_at),
    revision: row.revision,
  };
}

/** Units of each sale line returned so far, from the append-only returns. */
export function returnedUnits(returns: PosReturnRow[]): Map<string, number> {
  const units = new Map<string, number>();
  for (const r of returns) {
    for (const line of r.lines as PosReturnLineRecord[]) {
      units.set(line.saleLineId, (units.get(line.saleLineId) ?? 0) + line.quantity);
    }
  }
  return units;
}

export interface PosSaleParts {
  lines: PosSaleLineRow[];
  tenders: PosTenderRow[];
  returns: PosReturnRow[];
  attemptStatus: Map<string, string>;
  refundStatus: Map<string, string>;
}

export async function loadSaleParts(db: Reader, sale: PosSaleRow): Promise<PosSaleParts> {
  const organizationId = sale.organization_id;
  const lines = await db
    .selectFrom('pos_sale_lines')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('sale_id', '=', sale.id)
    .orderBy('line_number')
    .execute();
  const tenders = await db
    .selectFrom('pos_tenders')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('sale_id', '=', sale.id)
    .orderBy('recorded_at')
    .orderBy('id')
    .execute();
  const returns = await db
    .selectFrom('pos_returns')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('sale_id', '=', sale.id)
    .orderBy('returned_at')
    .orderBy('id')
    .execute();
  const attemptIds = tenders.map((t) => t.payment_attempt_id).filter((id): id is string => !!id);
  const attempts =
    attemptIds.length === 0
      ? []
      : await db
          .selectFrom('payment_attempts')
          .select(['id', 'status'])
          .where('organization_id', '=', organizationId)
          .where('id', 'in', attemptIds)
          .execute();
  const refundIds = returns.map((r) => r.refund_attempt_id).filter((id): id is string => !!id);
  const refunds =
    refundIds.length === 0
      ? []
      : await db
          .selectFrom('refund_attempts')
          .select(['id', 'status'])
          .where('organization_id', '=', organizationId)
          .where('id', 'in', refundIds)
          .execute();
  return {
    lines,
    tenders,
    returns,
    attemptStatus: new Map(attempts.map((a) => [a.id, a.status])),
    refundStatus: new Map(refunds.map((r) => [r.id, r.status])),
  };
}

function toLine(row: PosSaleLineRow, returned: number): PosSaleLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    kind: row.kind,
    unitPriceMinor: Number(row.unit_price_minor),
    quantity: row.quantity,
    baseMinor: Number(row.base_minor),
    charges: row.charges as PosLineChargeRecord[],
    chargesMinor: Number(row.charges_minor),
    lineTotalMinor: Number(row.line_total_minor),
    returnedQuantity: returned,
  };
}

function toTender(row: PosTenderRow, attemptStatus: Map<string, string>): PosTender {
  const evidence = row.evidence as { reference?: unknown } | null;
  return {
    id: row.id,
    kind: row.kind,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    paymentAttemptId: row.payment_attempt_id,
    paymentStatus: row.payment_attempt_id
      ? ((attemptStatus.get(row.payment_attempt_id) ?? null) as PosTender['paymentStatus'])
      : null,
    evidenceReference: typeof evidence?.reference === 'string' ? evidence.reference : null,
    failureReason: row.failure_reason,
    recordedByPersonId: row.recorded_by_person_id,
    recordedAt: iso(row.recorded_at),
    settledAt: isoOrNull(row.settled_at),
  };
}

function toReturn(row: PosReturnRow, refundStatus: Map<string, string>): PosReturn {
  return {
    id: row.id,
    amountMinor: Number(row.amount_minor),
    tenderKind: row.tender_kind,
    lines: row.lines as PosReturnLineRecord[],
    refundAttemptId: row.refund_attempt_id,
    refundStatus: row.refund_attempt_id
      ? ((refundStatus.get(row.refund_attempt_id) ?? null) as PosReturn['refundStatus'])
      : null,
    registerSessionId: row.register_session_id,
    reason: row.reason,
    approvedByPersonId: row.approved_by_person_id,
    returnedAt: iso(row.returned_at),
  };
}

export function toPosSale(sale: PosSaleRow, parts: PosSaleParts): PosSale {
  const units = returnedUnits(parts.returns);
  const settled = parts.tenders
    .filter((t) => t.status === 'settled')
    .reduce((sum, t) => sum + Number(t.amount_minor), 0);
  const pending = parts.tenders
    .filter((t) => t.status === 'pending')
    .reduce((sum, t) => sum + Number(t.amount_minor), 0);
  const returned = parts.returns.reduce((sum, r) => sum + Number(r.amount_minor), 0);
  const total = Number(sale.total_minor);
  return {
    id: sale.id,
    saleNumber: sale.sale_number,
    registerSessionId: sale.register_session_id,
    facilityId: sale.facility_id,
    customerPersonId: sale.customer_person_id,
    status: sale.status,
    currency: sale.currency,
    subtotalMinor: Number(sale.subtotal_minor),
    chargesMinor: Number(sale.charges_minor),
    totalMinor: total,
    settledMinor: settled,
    pendingMinor: pending,
    remainingMinor: sale.status === 'open' ? Math.max(total - settled - pending, 0) : 0,
    returnedMinor: returned,
    lines: parts.lines.map((l) => toLine(l, units.get(l.id) ?? 0)),
    tenders: parts.tenders.map((t) => toTender(t, parts.attemptStatus)),
    returns: parts.returns.map((r) => toReturn(r, parts.refundStatus)),
    paidAt: isoOrNull(sale.paid_at),
    voidReason: sale.void_reason,
    voidedAt: isoOrNull(sale.voided_at),
    revision: sale.revision,
    createdAt: iso(sale.created_at),
  };
}

/** The customer's receipt: amounts and approved charges, never evidence or staff details. */
export function toPosReceipt(sale: PosSaleRow, parts: PosSaleParts): PosReceipt {
  const charges = new Map<
    string,
    { code: string; label: string; kind: 'tax' | 'fee'; amountMinor: number }
  >();
  for (const line of parts.lines) {
    for (const c of line.charges as PosLineChargeRecord[]) {
      const key = `${c.kind}:${c.code}:${c.label}`;
      const current = charges.get(key) ?? {
        code: c.code,
        label: c.label,
        kind: c.kind,
        amountMinor: 0,
      };
      current.amountMinor += c.amountMinor;
      charges.set(key, current);
    }
  }
  return {
    saleId: sale.id,
    saleNumber: sale.sale_number,
    facilityId: sale.facility_id,
    status: sale.status,
    currency: sale.currency,
    lines: parts.lines.map((l) => ({
      name: l.name,
      kind: l.kind,
      quantity: l.quantity,
      unitPriceMinor: Number(l.unit_price_minor),
      baseMinor: Number(l.base_minor),
      charges: l.charges as PosLineChargeRecord[],
      lineTotalMinor: Number(l.line_total_minor),
    })),
    subtotalMinor: Number(sale.subtotal_minor),
    charges: [...charges.values()],
    totalMinor: Number(sale.total_minor),
    tenders: parts.tenders
      .filter((t) => t.status === 'settled')
      .map((t) => ({ kind: t.kind, amountMinor: Number(t.amount_minor) })),
    returns: parts.returns.map((r) => ({
      amountMinor: Number(r.amount_minor),
      tenderKind: r.tender_kind,
      returnedAt: iso(r.returned_at),
    })),
    paidAt: isoOrNull(sale.paid_at),
  };
}
