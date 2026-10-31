/**
 * SCR-S-55 one sale (§3.16 POS; SPK-PAY-001, SPK-PAY-002, SPK-PAY-007, SPK-PAY-008, SPK-PAY-012):
 * its lines at the product's price with the approved taxes and fees the API applied, its totals,
 * tenders and returns (`GET /v1/pos-sales/{id}`), and the commands its state allows:
 *
 * - open: add a line (only while `point_of_sale` is on), take a cash, external or card tender
 *   (SaleForms; never gated, a tender settles an existing sale, DEC-016), void it with a reason
 *   while it holds no card tender (`POST /v1/pos-sales/{id}/void`, never gated);
 * - paid or partially returned: return lines within what was paid (ReturnForm), and the receipt.
 *
 * A sale is shown as paid only when the API says `paid`. A card tender whose outcome is unknown
 * leaves the sale open: the page says recovery is required, that the card must not be taken again,
 * and links to the payment attempt to reconcile from the provider's evidence (SPK-PAY-007). A card
 * payment still processing is "not paid yet", never success. Times are in the facility's zone.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { useFacilityDirectory } from '../../../features/pos-access-accounting/facilities';
import { LinkNotAvailable, useRecordParam } from '../../../features/pos-access-accounting/fields';
import {
  CARD_PAYMENT_STATUS,
  POS_PRODUCT_KIND,
  POS_SALE_STATUS,
  POS_TENDER_KIND,
  POS_TENDER_STATUS,
  RETURN_REFUND_STATUS,
} from '../../../features/pos-access-accounting/labels';
import { POS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import {
  formatInstant,
  formatMoney,
  shortRef,
} from '../../../features/registration-finance/format';
import { PersonName } from '../../../features/registration-finance/names';
import { useOnline } from '../../../features/registration-finance/offline';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { POS_PATHS, SALE_QUERY_PREFIX } from './paths';
import { AddLineForm, ReturnForm, TenderForm } from './SaleForms';

type Sale = Schema<'PosSale'>;

export function SalePage() {
  const saleId = useRecordParam('saleId');
  if (!saleId) return <LinkNotAvailable />;
  return <SaleView saleId={saleId} />;
}

function SaleView({ saleId }: { saleId: string }) {
  const sale = useApiQuery({ path: '/pos-sales/{id}', request: { path: { id: saleId } } });
  return (
    <section aria-labelledby="pos-sale-title">
      <h3 id="pos-sale-title">Sale {sale.data?.saleNumber ?? shortRef(saleId)}</h3>
      <QueryBoundary
        query={sale}
        label="the sale"
        empty={{ title: '', description: '' }}
        unavailableOffline={['adding lines', 'tenders', 'returns', 'voiding']}
      >
        {(data) => <SaleBody sale={data} onReload={() => void sale.refetch()} />}
      </QueryBoundary>
    </section>
  );
}

/** Card tenders the provider has not finished: `unknown` is recovery, the others in progress. */
function cardState(sale: Sale) {
  const cards = sale.tenders.filter((t) => t.kind === 'card');
  return {
    unknown: cards.filter((t) => t.paymentStatus === 'unknown'),
    inProgress: cards.filter((t) => t.status === 'pending' && t.paymentStatus !== 'unknown'),
    /** A void is refused once a card was charged or is being charged (SALE_HAS_CARD_TENDER). */
    blocksVoid: cards.some((t) => t.status === 'pending' || t.status === 'settled'),
  };
}

function SaleBody({ sale, onReload }: { sale: Sale; onReload: () => void }) {
  const directory = useFacilityDirectory();
  const offer = useOffer();
  const zone = directory.timeZoneOf(sale.facilityId);
  const cards = cardState(sale);
  const c = sale.currency;
  const operate = offer.allowed(POS_ACTIONS.operateRegister, sale.facilityId);
  // DEC-016: with point_of_sale off no line is added, but an open sale can still be paid (a
  // tender settles an existing sale and is never gated, CAPABILITIES-01).
  const switchOn = offer.capabilityOn('point_of_sale');
  const tendering = sale.status === 'open' && operate;
  const selling = tendering && switchOn;
  const returnable =
    (sale.status === 'paid' || sale.status === 'partially_returned') &&
    offer.allowed(POS_ACTIONS.approveReturn, sale.facilityId);
  const hasReceipt =
    sale.status === 'paid' || sale.status === 'partially_returned' || sale.status === 'returned';
  return (
    <>
      <p>
        <StatusBadge {...POS_SALE_STATUS[sale.status]} />
      </p>
      {cards.unknown.length > 0 ? <UnknownCardRecovery tenders={cards.unknown} /> : null}
      {cards.inProgress.length > 0 ? (
        <section className="state" aria-live="polite" data-testid="state-processing">
          <StatusBadge tone="pending" label="Card payment in progress: not paid yet" />
          <p>
            The sale is paid only once the provider confirms the card payment. Reload to see its
            outcome; do not take the card again.
          </p>
        </section>
      ) : null}
      <Facts
        label="Sale"
        items={[
          ['Sale number', sale.saleNumber],
          ['Facility', directory.nameOf(sale.facilityId)],
          [
            'Customer',
            sale.customerPersonId ? (
              <PersonName key="c" id={sale.customerPersonId} fallback="Customer" />
            ) : (
              'Not named'
            ),
          ],
          [
            'Register session',
            <Link key="s" to={POS_PATHS.session(sale.registerSessionId)}>
              Session {shortRef(sale.registerSessionId)}
            </Link>,
          ],
          ['Started at', formatInstant(sale.createdAt, zone)],
          ['Paid at', sale.paidAt ? formatInstant(sale.paidAt, zone) : 'Not paid'],
          ...(sale.voidReason
            ? ([
                ['Voided at', formatInstant(sale.voidedAt, zone)],
                ['Void reason', sale.voidReason],
              ] as [string, string][])
            : []),
        ]}
      />
      <Facts
        label="Sale totals"
        items={[
          ['Subtotal', formatMoney(sale.subtotalMinor, c)],
          ['Taxes and fees', formatMoney(sale.chargesMinor, c)],
          ['Total', formatMoney(sale.totalMinor, c)],
          ['Paid (settled tenders)', formatMoney(sale.settledMinor, c)],
          ['Card payments not final', formatMoney(sale.pendingMinor, c)],
          ['Remaining to pay', formatMoney(sale.remainingMinor, c)],
          ['Returned', formatMoney(sale.returnedMinor, c)],
        ]}
      />
      <Lines sale={sale} />
      <Tenders sale={sale} zone={zone} />
      <Returns sale={sale} zone={zone} />
      {selling ? <AddLineForm sale={sale} onReload={onReload} /> : null}
      {tendering && !switchOn ? (
        <p className="caption">
          Point of sale is turned off: no line is added to this sale, but what it already holds can
          still be paid, or the sale voided.
        </p>
      ) : null}
      {tendering && sale.lines.length > 0 && sale.remainingMinor > 0 ? (
        <TenderForm sale={sale} onReload={onReload} />
      ) : null}
      {sale.status === 'open' && operate ? (
        cards.blocksVoid ? (
          <p className="caption">
            A card was charged or is being charged for this sale, so it cannot be voided: complete
            it, then return what was bought.
          </p>
        ) : (
          <VoidSale sale={sale} onReload={onReload} />
        )
      ) : null}
      {returnable ? <ReturnForm sale={sale} onReload={onReload} /> : null}
      {hasReceipt ? (
        <p>
          <Link to={POS_PATHS.receipt(sale.id)}>Open the receipt of sale {sale.saleNumber}</Link>
        </p>
      ) : null}
    </>
  );
}

function UnknownCardRecovery({ tenders }: { tenders: Schema<'PosTender'>[] }) {
  return (
    <section className="state" aria-live="polite" data-testid="state-recovery">
      <StatusBadge tone="warning" label="Recovery required: card payment outcome unknown" />
      <p>
        The provider has not confirmed this card payment. The sale stays open and is not paid. Do
        not take the card again: reconcile the payment attempt from the provider&apos;s evidence
        first (SPK-PAY-007).
      </p>
      <ul aria-label="Card payments to reconcile">
        {tenders.map((t) =>
          t.paymentAttemptId ? (
            <li key={t.id}>
              <Link to={`/finance/payments/${t.paymentAttemptId}`}>
                Open the payment attempt of {formatMoney(t.amountMinor, t.currency)} to reconcile it
              </Link>
            </li>
          ) : (
            <li key={t.id}>{formatMoney(t.amountMinor, t.currency)}: no payment attempt named</li>
          ),
        )}
      </ul>
    </section>
  );
}

function Lines({ sale }: { sale: Sale }) {
  if (sale.lines.length === 0) {
    return <p className="caption">No lines yet. Add a product to the sale.</p>;
  }
  const c = sale.currency;
  return (
    <div className="rf-table-wrap">
      <table className="rf-table" aria-label="Sale lines">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Product</th>
            <th scope="col">Unit price</th>
            <th scope="col">Quantity</th>
            <th scope="col">Taxes and fees</th>
            <th scope="col">Line total</th>
            <th scope="col">Returned</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.lineNumber}</td>
              <td>
                {line.name} ({line.sku}) · {POS_PRODUCT_KIND[line.kind]}
              </td>
              <td>{formatMoney(line.unitPriceMinor, c)}</td>
              <td>{line.quantity}</td>
              <td>
                {line.charges.length === 0
                  ? 'None'
                  : line.charges.map((charge) => (
                      <span key={charge.policyVersionId} className="caption">
                        {charge.label} ({charge.kind}): {formatMoney(charge.amountMinor, c)}{' '}
                      </span>
                    ))}
              </td>
              <td>{formatMoney(line.lineTotalMinor, c)}</td>
              <td>{line.returnedQuantity}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tenders({ sale, zone }: { sale: Sale; zone: string | null }) {
  if (sale.tenders.length === 0) return <p className="caption">No tender taken yet.</p>;
  return (
    <div className="rf-table-wrap">
      <table className="rf-table" aria-label="Tenders">
        <thead>
          <tr>
            <th scope="col">Tender</th>
            <th scope="col">Amount</th>
            <th scope="col">State</th>
            <th scope="col">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {sale.tenders.map((t) => (
            <tr key={t.id}>
              <td>
                {POS_TENDER_KIND[t.kind]}
                {t.evidenceReference ? (
                  <span className="caption"> Evidence: {t.evidenceReference}</span>
                ) : null}
              </td>
              <td>{formatMoney(t.amountMinor, t.currency)}</td>
              <td>
                <StatusBadge {...POS_TENDER_STATUS[t.status]} />{' '}
                {t.paymentStatus ? <StatusBadge {...CARD_PAYMENT_STATUS[t.paymentStatus]} /> : null}
                {t.failureReason ? <span className="caption"> {t.failureReason}</span> : null}
                {t.paymentAttemptId ? (
                  <>
                    {' '}
                    <Link to={`/finance/payments/${t.paymentAttemptId}`}>Payment attempt</Link>
                  </>
                ) : null}
              </td>
              <td>
                {formatInstant(t.recordedAt, zone)} by{' '}
                <PersonName id={t.recordedByPersonId} fallback="Staff" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Returns({ sale, zone }: { sale: Sale; zone: string | null }) {
  if (sale.returns.length === 0) return null;
  const lineNumber = new Map(sale.lines.map((l) => [l.id, l.lineNumber]));
  return (
    <div className="rf-table-wrap">
      <table className="rf-table" aria-label="Returns">
        <thead>
          <tr>
            <th scope="col">Returned</th>
            <th scope="col">Lines</th>
            <th scope="col">Refund</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {sale.returns.map((r) => (
            <tr key={r.id}>
              <td>
                {formatMoney(r.amountMinor, sale.currency)} by {POS_TENDER_KIND[r.tenderKind]}
                <span className="caption"> {formatInstant(r.returnedAt, zone)}</span>
              </td>
              <td>
                {r.lines
                  .map((l) => `line ${lineNumber.get(l.saleLineId) ?? '?'} × ${l.quantity}`)
                  .join(', ')}
              </td>
              <td>
                {r.refundStatus ? (
                  <>
                    <StatusBadge {...RETURN_REFUND_STATUS[r.refundStatus]} />
                    {r.refundAttemptId && r.refundStatus !== 'succeeded' ? (
                      <>
                        {' '}
                        <Link to={`/finance/refunds/${r.refundAttemptId}`}>Open the refund</Link>
                      </>
                    ) : null}
                  </>
                ) : (
                  'Paid out at the register'
                )}
              </td>
              <td>
                {r.reason}
                <span className="caption">
                  {' '}
                  Approved by <PersonName id={r.approvedByPersonId} fallback="Staff" />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VoidSale({ sale, onReload }: { sale: Sale; onReload: () => void }) {
  const online = useOnline();
  const command = useApiCommand('post', '/pos-sales/{id}/void', {
    invalidate: [SALE_QUERY_PREFIX],
  });
  return (
    <div>
      <ReasonAction
        label="Void the sale"
        confirmLabel="Void the sale"
        reasonLabel="Reason for voiding"
        explanation="A voided sale is kept with its reason; cash already tendered is no longer expected in the drawer."
        busy={command.isProcessing}
        disabled={!online}
        onConfirm={async (reason) => {
          try {
            await command.submit({
              path: { id: sale.id },
              body: { reason, expectedRevision: sale.revision },
            });
            return true;
          } catch {
            return false;
          }
        }}
      />
      <CommandError
        error={command.error}
        onReload={() => {
          command.reset();
          onReload();
        }}
        currency={sale.currency}
      />
    </div>
  );
}
