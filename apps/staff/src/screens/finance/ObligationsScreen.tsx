/**
 * SCR-S-35 Obligations and orders, lists (SPK-PAY-002, SPK-PAY-004, SPK-PAY-006, SPK-PAY-011,
 * SPK-REG-003). Two views of the API's keyset pages with "Load more" (§4.5), so nothing is
 * silently cut off:
 *
 * - Obligations (`GET /v1/obligations`) per customer or per team (`debtorPersonId`,
 *   `teamEntryId`), each with its billing model, the four figures shown consistently, and a
 *   payment still on its way (`liveAttempt`, FIN-01: unknown is never shown as paid).
 * - Orders (`GET /v1/orders`, finance readers) by payer, payment state, fulfillment state and
 *   creation period; `recovery_required` (money received, fulfillment incomplete) is listed with
 *   its owner queue and opens the order (`/finance/orders/:orderId`).
 *
 * Read-only: nothing here changes money. Team liability models and balance consequences are
 * pending DEC-008/DEC-073; the figures shown are the API's. Money records carry no facility, so
 * the period is entered and shown in UTC and the labels say so.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { SelectField, TextField } from '../../features/registration-finance/fields';
import {
  dateToInstant,
  formatInstant,
  formatMoney,
} from '../../features/registration-finance/format';
import {
  OBLIGATION_MODE,
  OBLIGATION_STATUS,
  ORDER_FULFILLMENT_STATUS,
  ORDER_PAYMENT_STATUS,
} from '../../features/registration-finance/labels';
import { LiveAttemptNotice } from '../../features/registration-finance/LiveAttempt';
import { PersonName, TeamEntryName } from '../../features/registration-finance/names';
import { ObligationFigures } from '../../features/registration-finance/ObligationFigures';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type ObligationStatus = Schema<'ObligationStatus'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Debtor({ obligation }: { obligation: Schema<'Obligation'> }) {
  return obligation.debtor.kind === 'person' ? (
    <PersonName id={obligation.debtor.personId} fallback="Customer" />
  ) : (
    <TeamEntryName id={obligation.debtor.teamEntryId} />
  );
}

type Order = Schema<'Order'>;

function ObligationList() {
  const [status, setStatus] = useState<ObligationStatus | ''>('open');
  const [debtor, setDebtor] = useState('');
  const [team, setTeam] = useState('');
  const debtorId = UUID.test(debtor.trim()) ? debtor.trim() : '';
  const teamId = UUID.test(team.trim()) ? team.trim() : '';
  const obligations = useApiPages({
    path: '/obligations',
    request: {
      query: {
        limit: 50,
        ...(status ? { status } : {}),
        ...(debtorId ? { debtorPersonId: debtorId } : teamId ? { teamEntryId: teamId } : {}),
      },
    },
  });
  return (
    <>
      <div className="rf-grid">
        <SelectField
          label="Obligation status"
          value={status}
          placeholder="All statuses"
          onChange={(v) => setStatus(v as ObligationStatus | '')}
          options={Object.entries(OBLIGATION_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
        <TextField
          label="Customer reference"
          value={debtor}
          onChange={setDebtor}
          hint="A person reference narrows to one customer."
        />
        <TextField
          label="Team entry reference"
          value={team}
          onChange={setTeam}
          hint="A team entry reference narrows to one team."
        />
      </div>
      <p className="caption">
        Team liability and balance consequences are pending {PENDING.teamLiability.ids.join(', ')}{' '}
        (owner: {PENDING.teamLiability.owner}).
      </p>
      <QueryBoundary
        query={obligations}
        label="obligations"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No obligations', description: 'No obligation matches these filters.' }}
      >
        {(items) => (
          <ul className="list" aria-label="Obligations">
            {items.map((obligation) => (
              <li key={obligation.id}>
                <div className="row-text">
                  <Link className="row-title" to={`/finance/obligations/${obligation.id}`}>
                    {obligation.description}
                  </Link>
                  <span className="caption">
                    <Debtor obligation={obligation} /> · {OBLIGATION_MODE[obligation.mode]} · due{' '}
                    {formatInstant(obligation.dueAt)}
                  </span>
                  <ObligationFigures
                    totals={obligation.totals}
                    label={`Figures: ${obligation.description}`}
                  />
                  <LiveAttemptNotice attempt={obligation.liveAttempt} />
                </div>
                <StatusBadge {...OBLIGATION_STATUS[obligation.status]} />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={obligations} label="obligations" />
    </>
  );
}

function OrderRow({ order }: { order: Order }) {
  return (
    <li>
      <div className="row-text">
        <Link className="row-title" to={`/finance/orders/${order.id}`}>
          Order {order.id.slice(0, 8)}: {formatMoney(order.totalMinor, order.currency)}
        </Link>
        <span className="caption">
          Payer <PersonName id={order.payerPersonId} fallback="Payer" /> · {order.lines.length}{' '}
          line(s) · created {formatInstant(order.createdAt, 'UTC')}
        </span>
        {order.fulfillmentStatus === 'recovery_required' ? (
          <span>
            Recovery required: money received, fulfillment incomplete. Owner: finance operator
            queue.
          </span>
        ) : null}
      </div>
      <span>
        <StatusBadge {...ORDER_PAYMENT_STATUS[order.paymentStatus]} />{' '}
        <StatusBadge {...ORDER_FULFILLMENT_STATUS[order.fulfillmentStatus]} />
      </span>
    </li>
  );
}

function OrderList() {
  const [payer, setPayer] = useState('');
  const [payment, setPayment] = useState<Order['paymentStatus'] | ''>('');
  const [fulfillment, setFulfillment] = useState<Order['fulfillmentStatus'] | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const payerId = UUID.test(payer.trim()) ? payer.trim() : '';
  const fromAt = from ? dateToInstant(from) : null;
  const toAt = to ? dateToInstant(to, true) : null;
  const orders = useApiPages({
    path: '/orders',
    request: {
      query: {
        limit: 50,
        ...(payerId ? { payerPersonId: payerId } : {}),
        ...(payment ? { paymentStatus: payment } : {}),
        ...(fulfillment ? { fulfillmentStatus: fulfillment } : {}),
        ...(fromAt ? { from: fromAt } : {}),
        ...(toAt ? { to: toAt } : {}),
      },
    },
  });
  return (
    <>
      <div className="rf-grid">
        <TextField
          label="Payer reference"
          value={payer}
          onChange={setPayer}
          hint="A person reference narrows to one payer."
        />
        <SelectField
          label="Payment state"
          value={payment}
          placeholder="Any payment state"
          onChange={(v) => setPayment(v as Order['paymentStatus'] | '')}
          options={Object.entries(ORDER_PAYMENT_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
        <SelectField
          label="Fulfillment state"
          value={fulfillment}
          placeholder="Any fulfillment state"
          onChange={(v) => setFulfillment(v as Order['fulfillmentStatus'] | '')}
          options={Object.entries(ORDER_FULFILLMENT_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
        <TextField label="Created from (UTC day)" type="date" value={from} onChange={setFrom} />
        <TextField label="Created through (UTC day)" type="date" value={to} onChange={setTo} />
      </div>
      <QueryBoundary
        query={orders}
        label="orders"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No orders', description: 'No order matches these filters.' }}
      >
        {(items) => (
          <ul className="list" aria-label="Orders">
            {items.map((order) => (
              <OrderRow key={order.id} order={order} />
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={orders} label="orders" />
    </>
  );
}

export function ObligationsScreen() {
  const [view, setView] = useState<'obligations' | 'orders'>('obligations');
  return (
    <section aria-labelledby="obligations-title">
      <h2 id="obligations-title">Obligations and orders</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <div className="rf-actions" role="group" aria-label="Show">
        <Button
          variant={view === 'obligations' ? 'primary' : 'secondary'}
          aria-pressed={view === 'obligations'}
          onClick={() => setView('obligations')}
        >
          Obligations
        </Button>
        <Button
          variant={view === 'orders' ? 'primary' : 'secondary'}
          aria-pressed={view === 'orders'}
          onClick={() => setView('orders')}
        >
          Orders
        </Button>
      </div>
      {view === 'obligations' ? <ObligationList /> : <OrderList />}
    </section>
  );
}
