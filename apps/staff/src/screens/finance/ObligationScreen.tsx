/**
 * SCR-S-35 one obligation (SPK-PAY-002, SPK-PAY-004, SPK-PAY-006, SPK-REG-003): its four figures,
 * team contributions (amount and status, never another player's account), the order it came from
 * with each line's price and policy basis, and the installment plan with amounts, due dates,
 * authorization, retry and notice policy, extensions and outstanding balance. A failed installment
 * is a financial state with an action queue (the finance operator exceptions); participation
 * consequences are evaluated separately. Read-only; a checkout whose fulfillment is
 * `recovery_required` is listed with its owner queue and links to SCR-S-36.
 */
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { Facts } from '../../features/registration-finance/fields';
import { formatInstant, formatMoney, shortRef } from '../../features/registration-finance/format';
import {
  INSTALLMENT_STATUS,
  OBLIGATION_MODE,
  OBLIGATION_STATUS,
} from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { ObligationFigures } from '../../features/registration-finance/ObligationFigures';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { Debtor } from './ObligationsScreen';

function OrderSection({ orderId }: { orderId: string }) {
  const order = useApiQuery({ path: '/orders/{id}', request: { path: { id: orderId } } });
  return (
    <section className="rf-panel" aria-labelledby="order-title">
      <h3 id="order-title">Order {shortRef(orderId)}</h3>
      <QueryBoundary query={order} label="the order" empty={{ title: '', description: '' }}>
        {(data) => (
          <>
            <p>
              <StatusBadge
                tone={
                  data.paymentStatus === 'paid'
                    ? 'success'
                    : data.paymentStatus === 'canceled'
                      ? 'neutral'
                      : 'pending'
                }
                label={`Payment ${data.paymentStatus}`}
              />{' '}
              <StatusBadge
                tone={
                  data.fulfillmentStatus === 'fulfilled'
                    ? 'success'
                    : data.fulfillmentStatus === 'recovery_required'
                      ? 'danger'
                      : 'neutral'
                }
                label={`Fulfillment ${data.fulfillmentStatus}`}
              />
            </p>
            {data.fulfillmentStatus === 'recovery_required' ? (
              <p>
                Recovery required: money was received but fulfillment is incomplete. Owner: finance
                operator queue. <Link to="/finance/payments">Open checkouts needing recovery</Link>.
              </p>
            ) : null}
            <div className="rf-table-wrap">
              <table className="rf-table" aria-label="Order lines">
                <thead>
                  <tr>
                    <th scope="col">Participant and item</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Base</th>
                    <th scope="col">Discount</th>
                    <th scope="col">Tax and fees</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <PersonName id={line.participantPersonId} fallback="Participant" />:{' '}
                        <OfferingName id={line.offeringId} />
                        <div className="caption">{line.description}</div>
                      </td>
                      <td>{line.quantity}</td>
                      <td>{formatMoney(line.baseAmountMinor, line.currency)}</td>
                      <td>{formatMoney(line.discountMinor, line.currency)}</td>
                      <td>{formatMoney(line.taxMinor + line.feeMinor, line.currency)}</td>
                      <td>{formatMoney(line.totalMinor, line.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Facts
              label="Order totals"
              items={[
                ['Total', formatMoney(data.totalMinor, data.currency)],
                ['Credits applied', formatMoney(data.creditsAppliedMinor, data.currency)],
                ['Due at checkout', formatMoney(data.dueNowMinor, data.currency)],
                ['Paid', formatInstant(data.paidAt)],
              ]}
            />
            {data.installmentPlanId ? (
              <InstallmentPlanSection planId={data.installmentPlanId} />
            ) : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

function InstallmentPlanSection({ planId }: { planId: string }) {
  const plan = useApiQuery({ path: '/installment-plans/{id}', request: { path: { id: planId } } });
  return (
    <section aria-labelledby="plan-title">
      <h4 id="plan-title">Installment plan</h4>
      <QueryBoundary
        query={plan}
        label="the installment plan"
        empty={{ title: '', description: '' }}
      >
        {(data) => {
          const failed = data.installments.filter((i) => i.status === 'failed');
          return (
            <>
              <Facts
                label="Installment plan"
                items={[
                  ['Plan status', data.status],
                  ['Total', formatMoney(data.totalMinor, data.currency)],
                  ['Outstanding', formatMoney(data.outstandingMinor, data.currency)],
                  ['Authorized', formatInstant(data.authorization.authorizedAt)],
                  [
                    'Retry policy',
                    `${data.retryPolicy.maxAttempts} attempts, every ${data.retryPolicy.retryIntervalHours} hours`,
                  ],
                  ['Notice', `${data.noticePolicy.daysBefore} days before each due date`],
                ]}
              />
              {failed.length > 0 ? (
                <p>
                  {failed.length} failed installment(s): a financial state with an action queue
                  (finance operator). Participation consequences are evaluated separately.{' '}
                  <Link to="/finance/payments">Open the finance exceptions</Link>.
                </p>
              ) : null}
              <div className="rf-table-wrap">
                <table className="rf-table" aria-label="Installments">
                  <thead>
                    <tr>
                      <th scope="col">Number</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Due</th>
                      <th scope="col">Status</th>
                      <th scope="col">Attempts and extensions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.installments.map((installment) => (
                      <tr key={installment.id}>
                        <td>{installment.sequence}</td>
                        <td>{formatMoney(installment.amountMinor, installment.currency)}</td>
                        <td>
                          {formatInstant(installment.dueAt)}
                          {installment.dueAt !== installment.originalDueAt ? (
                            <div className="caption">
                              Originally {formatInstant(installment.originalDueAt)}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <StatusBadge {...INSTALLMENT_STATUS[installment.status]} />
                          {installment.lastFailureReason ? (
                            <div className="caption">
                              Last failure: {installment.lastFailureReason}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {installment.attemptCount} attempt(s), {installment.extensionCount}{' '}
                          extension(s)
                          {installment.nextRetryAt ? (
                            <div className="caption">
                              Next retry {formatInstant(installment.nextRetryAt)}
                            </div>
                          ) : null}
                          {installment.noticeSentAt ? (
                            <div className="caption">
                              Notice sent {formatInstant(installment.noticeSentAt)}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}

export function ObligationScreen() {
  const { obligationId = '' } = useParams();
  const obligation = useApiQuery({
    path: '/obligations/{id}',
    request: { path: { id: obligationId } },
  });
  return (
    <section aria-labelledby="obligation-title">
      {/* SPK-UX-009: the region keeps its name and the area navigation in every state. */}
      <h2 id="obligation-title">Obligation</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <QueryBoundary
        query={obligation}
        label="the obligation"
        empty={{ title: '', description: '' }}
      >
        {(data) => (
          <>
            <h3>{data.description}</h3>
            <p>
              <StatusBadge {...OBLIGATION_STATUS[data.status]} />{' '}
              <span className="caption">
                <Debtor obligation={data} /> · {OBLIGATION_MODE[data.mode]} · due{' '}
                {formatInstant(data.dueAt)}
              </span>
            </p>
            {data.responsiblePayerPersonId ? (
              <p>
                Responsible payer:{' '}
                <PersonName id={data.responsiblePayerPersonId} fallback="Payer" />
              </p>
            ) : null}
            <ObligationFigures totals={data.totals} />
            {data.contributions ? (
              <section className="rf-panel" aria-labelledby="contributions-title">
                <h3 id="contributions-title">Player contributions</h3>
                <p className="caption">
                  Contributions count toward this one team obligation; they never copy the debt.
                </p>
                {data.contributions.length === 0 ? (
                  <p>No contributions requested.</p>
                ) : (
                  <ul className="list" aria-label="Contributions">
                    {data.contributions.map((c) => (
                      <li key={c.id}>
                        <span>
                          <PersonName id={c.requestedPersonId} fallback="Player" />:{' '}
                          {formatMoney(c.amountMinor, c.currency)}
                        </span>
                        <StatusBadge
                          tone={
                            c.status === 'paid'
                              ? 'success'
                              : c.status === 'canceled'
                                ? 'neutral'
                                : 'pending'
                          }
                          label={c.status}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
            {data.orderId ? <OrderSection orderId={data.orderId} /> : null}
            <p>
              <Link to={`/finance/reconciliation?obligation=${data.id}`}>
                Record a cash or external tender against this obligation (SCR-S-38)
              </Link>
            </p>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
