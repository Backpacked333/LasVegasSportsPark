/**
 * SCR-S-35 one order (SPK-PAY-002, SPK-PAY-011, §4.11): the order with each line's price and
 * policy basis, its payment and fulfillment states, the installment plan, the obligations it
 * created, and its payment attempts (`GET /v1/payments?orderId=`, FIN-02). Reached from the order
 * list, an obligation, or an assisted registration's basket (its `orderRef`, FIN-04). Read-only;
 * `recovery_required` is shown with its owner queue and the checkout to recover (SCR-S-36).
 */
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { shortRef } from '../../features/registration-finance/format';
import { PaymentAttemptList } from '../../features/registration-finance/PaymentAttempts';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { OrderSection } from './ObligationScreen';

function OrderObligations({ obligationIds }: { obligationIds: readonly string[] }) {
  return obligationIds.length === 0 ? (
    <p>No obligation was created for this order.</p>
  ) : (
    <ul className="list" aria-label="Obligations of the order">
      {obligationIds.map((id) => (
        <li key={id}>
          <Link to={`/finance/obligations/${id}`}>Obligation {shortRef(id)}</Link>
        </li>
      ))}
    </ul>
  );
}

export function OrderScreen() {
  const { orderId = '' } = useParams();
  // Shares the cache entry OrderSection reads.
  const order = useApiQuery({ path: '/orders/{id}', request: { path: { id: orderId } } });
  return (
    <section aria-labelledby="order-screen-title">
      {/* SPK-UX-009: the region keeps its name and the area navigation in every state. */}
      <h2 id="order-screen-title">Order</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      {/* §4.10: the obligations and payment attempts are listed only for an order the viewer may
          read, so an unavailable order never shows "no payment attempt", which would imply that
          it exists. */}
      <QueryBoundary query={order} label="the order" empty={{ title: '', description: '' }}>
        {(data) => (
          <>
            <OrderSection orderId={data.id} />
            <section className="rf-panel" aria-labelledby="order-obligations-title">
              <h3 id="order-obligations-title">Obligations</h3>
              <OrderObligations obligationIds={data.obligationIds} />
            </section>
            <section className="rf-panel" aria-labelledby="order-payments-title">
              <h3 id="order-payments-title">Payment attempts</h3>
              <PaymentAttemptList
                filter={{ orderId: data.id }}
                label="Payment attempts of the order"
                showPayer={false}
              />
            </section>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
