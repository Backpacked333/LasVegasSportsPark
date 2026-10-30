/**
 * SCR-S-55 receipt (§3.16 POS "receipts", SPK-PAY-002): what the customer keeps, as the API
 * states it (`GET /v1/pos-sales/{id}/receipt`): lines with their approved taxes and fees, the
 * charges totalled by code, tenders and returns. An unpaid sale has no receipt
 * (RECEIPT_NOT_AVAILABLE), shown with a way back to the sale; a receipt the viewer may not read is
 * "not available" without implying it exists (§4.10). Times are in the facility's zone.
 */
import { Link } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { CommandError, detailCode } from '../../../features/pos-access-accounting/CommandError';
import { useFacilityDirectory } from '../../../features/pos-access-accounting/facilities';
import { LinkNotAvailable, useRecordParam } from '../../../features/pos-access-accounting/fields';
import { POS_SALE_STATUS, POS_TENDER_KIND } from '../../../features/pos-access-accounting/labels';
import { formatInstant, formatMoney } from '../../../features/registration-finance/format';
import { Facts } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StatusBadge } from '../../../ui/StatusBadge';
import { POS_PATHS } from './paths';

export function ReceiptPage() {
  const saleId = useRecordParam('saleId');
  if (!saleId) return <LinkNotAvailable />;
  return <ReceiptView saleId={saleId} />;
}

function ReceiptView({ saleId }: { saleId: string }) {
  const directory = useFacilityDirectory();
  const receipt = useApiQuery({
    path: '/pos-sales/{id}/receipt',
    request: { path: { id: saleId } },
  });
  const back = <Link to={POS_PATHS.sale(saleId)}>Back to the sale</Link>;
  if (receipt.data === undefined && detailCode(receipt.error) === 'RECEIPT_NOT_AVAILABLE') {
    return (
      <section aria-labelledby="pos-receipt-title">
        <h3 id="pos-receipt-title">Receipt</h3>
        <CommandError error={receipt.error} />
        <p>{back}</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="pos-receipt-title">
      <h3 id="pos-receipt-title">Receipt {receipt.data?.saleNumber ?? ''}</h3>
      <QueryBoundary query={receipt} label="the receipt" empty={{ title: '', description: '' }}>
        {(data) => {
          const zone = directory.timeZoneOf(data.facilityId);
          const c = data.currency;
          return (
            <article aria-label={`Receipt of sale ${data.saleNumber}`}>
              <p>
                <StatusBadge {...POS_SALE_STATUS[data.status]} />
              </p>
              <Facts
                label="Receipt"
                items={[
                  ['Sale number', data.saleNumber],
                  ['Facility', directory.nameOf(data.facilityId)],
                  ['Paid at', data.paidAt ? formatInstant(data.paidAt, zone) : 'Not paid'],
                ]}
              />
              <div className="rf-table-wrap">
                <table className="rf-table" aria-label="Receipt lines">
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Quantity</th>
                      <th scope="col">Unit price</th>
                      <th scope="col">Taxes and fees</th>
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((line, i) => (
                      <tr key={`${line.name}-${i}`}>
                        <td>{line.name}</td>
                        <td>{line.quantity}</td>
                        <td>{formatMoney(line.unitPriceMinor, c)}</td>
                        <td>
                          {line.charges.length === 0
                            ? 'None'
                            : line.charges
                                .map((ch) => `${ch.label}: ${formatMoney(ch.amountMinor, c)}`)
                                .join(', ')}
                        </td>
                        <td>{formatMoney(line.lineTotalMinor, c)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Facts
                label="Receipt totals"
                items={[
                  ['Subtotal', formatMoney(data.subtotalMinor, c)],
                  ...data.charges.map(
                    (ch) =>
                      [`${ch.label} (${ch.code})`, formatMoney(ch.amountMinor, c)] as [
                        string,
                        string,
                      ],
                  ),
                  ['Total', formatMoney(data.totalMinor, c)],
                  ...data.tenders.map(
                    (t, i) =>
                      [
                        `Paid by ${POS_TENDER_KIND[t.kind]} (${i + 1})`,
                        formatMoney(t.amountMinor, c),
                      ] as [string, string],
                  ),
                  ...data.returns.map(
                    (r, i) =>
                      [
                        `Returned by ${POS_TENDER_KIND[r.tenderKind]} (${i + 1})`,
                        `${formatMoney(r.amountMinor, c)}, ${formatInstant(r.returnedAt, zone)}`,
                      ] as [string, string],
                  ),
                ]}
              />
            </article>
          );
        }}
      </QueryBoundary>
      <p>{back}</p>
    </section>
  );
}
