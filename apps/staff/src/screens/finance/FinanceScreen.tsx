/**
 * "Finance" area home (SPK-UX-005): SCR-S-35 to SCR-S-38 built here. The conditional finance
 * screens (SCR-S-53 memberships, SCR-S-54 session packages, SCR-S-55 point of sale, SCR-S-57
 * accounting export) are linked to their own pages (src/screens/package-g/), each behind its
 * capability switch (DEC-016); accounting export also waits on DEC-022.
 *
 * The overview is a read-only desk built from the API's own lists (nothing is computed that the
 * API did not state, money stays per currency, SPK-PAY-001):
 *
 * - money moved but not fulfilled (`finance.fulfillment_incomplete`, `finance.compensation_failed`)
 *   is pinned first in the finance operator's exceptions (`GET /v1/exceptions`), with its owner;
 * - unknown provider outcomes (`GET /v1/payments?status=unknown`, `GET /v1/refunds?status=unknown`)
 *   are listed explicitly, never shown as paid or failed (SPK-PAY-007);
 * - open obligations past their due date (`GET /v1/obligations?status=open`), each with "Remind"
 *   and a "Remind all" for the ones not reminded in the last day (`POST
 *   /v1/obligations/{id}/reminders`, finance.send_payment_reminder; an essential payment notice
 *   whose channels stay pending DEC-062);
 * - refunds still in flight and the month's reconciliation (`GET /v1/finance/reconciliation-report`)
 *   on the side, in the currency the loaded records carry.
 *
 * Counts say "loaded so far" (a trailing +) while the API has more pages: nothing is cut off silently.
 */
import type { Schema } from '@sportspark/api-client';
import { formatAge } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages, type ApiPagesResult } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { dateToInstant, formatMoney, humanize } from '../../features/registration-finance/format';
import {
  EXCEPTION_SEVERITY,
  EXCEPTION_STATUS,
  REFUND_STATUS,
} from '../../features/registration-finance/labels';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { Icon, type IconName } from '../../ui/Icon';
import { Kpi, KpiRow, PageHeader } from '../../ui/Page';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { PACKAGE_G_LIST } from '../package-g/registry';
import { Debtor } from './ObligationsScreen';
import { affectedLink, EXCEPTION_GROUPS } from './PaymentExceptionsScreen';
import './finance.css';

const CONDITIONAL = PACKAGE_G_LIST.filter((screen) => screen.area === 'finance');

const SCREENS: readonly {
  to: string;
  title: string;
  id: string;
  icon: IconName;
  purpose: string;
}[] = [
  {
    to: '/finance/obligations',
    title: 'Obligations and orders',
    id: 'SCR-S-35',
    icon: 'receipt_long',
    purpose:
      'Obligations per customer and team with total, received, allocated and remaining; orders by payment and fulfillment state, lines and installment plans.',
  },
  {
    to: '/finance/payments',
    title: 'Payment attempts and unknown outcomes',
    id: 'SCR-S-36',
    icon: 'credit_card',
    purpose:
      'Payment attempts by state, unknown and conflicting outcomes to reconcile from provider evidence before any retry, provider events, and checkouts needing recovery.',
  },
  {
    to: '/finance/credits',
    title: 'Refunds and credits',
    id: 'SCR-S-37',
    icon: 'undo',
    purpose:
      'Refunds by payment and state, each reserving the refundable amount before execution; credits with owner, currency, uses, expiry, balance and history.',
  },
  {
    to: '/finance/reconciliation',
    title: 'Reconciliation',
    id: 'SCR-S-38',
    icon: 'balance',
    purpose:
      'Orders, obligations, receipts, refunds, credits, fees, disputes, settlements and cash kept apart; settlement and cash records.',
  },
];

const CONDITIONAL_ICON: Record<string, IconName> = {
  memberships: 'badge',
  'session-packages': 'confirmation_number',
  'point-of-sale': 'point_of_sale',
  'accounting-exports': 'account_balance',
};

/** Money received but the registration or order not fulfilled: always first, with its owner. */
const MONEY_MOVED = new Set(['finance.fulfillment_incomplete', 'finance.compensation_failed']);
type OperationalException = Schema<'OperationalException'>;

export function orderFinanceExceptions(
  items: readonly OperationalException[],
): OperationalException[] {
  const finance = items.filter((e) => e.category.startsWith('finance.'));
  return [
    ...finance.filter((e) => MONEY_MOVED.has(e.category)),
    ...finance.filter((e) => !MONEY_MOVED.has(e.category)),
  ];
}

function groupTitle(category: string): string {
  return EXCEPTION_GROUPS.find((g) => g.categories.includes(category))?.title ?? humanize(category);
}

/** Totals per currency: amounts in different currencies are never added together. */
function totalsByCurrency(rows: readonly { amountMinor: number; currency: string }[]) {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amountMinor);
  return [...totals.entries()];
}

function moneyLine(rows: readonly { amountMinor: number; currency: string }[]): string {
  const totals = totalsByCurrency(rows);
  if (totals.length === 0) return '—';
  return totals.map(([currency, minor]) => formatMoney(minor, currency)).join(' + ');
}

const count = (n: number, more: boolean) => `${n}${more ? '+' : ''}`;

const DATE_LINE = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

function ExceptionCard({ exceptions }: { exceptions: ApiPagesResult<OperationalException> }) {
  const now = useNow();
  return (
    <section className="card card-flush fin-card" aria-labelledby="fin-exceptions-title">
      <div className="card-head">
        <h3 id="fin-exceptions-title">Payment exceptions</h3>
        <Link to="/finance/payments" className="fin-head-link">
          All exceptions <Icon name="chevron_right" size={18} />
        </Link>
      </div>
      <div className="fin-body">
        <QueryBoundary
          query={exceptions}
          label="finance exceptions"
          isEmpty={(items) => orderFinanceExceptions(items).length === 0 && !exceptions.hasNextPage}
          empty={{
            title: 'No payment exceptions',
            description:
              'No money moved without fulfillment, and no payment or refund outcome is waiting to be reconciled.',
          }}
          unavailableOffline={['reconciling']}
        >
          {(items) => {
            const ordered = orderFinanceExceptions(items).slice(0, 8);
            return (
              <ul className="fin-rows" aria-label="Payment exceptions, money moved first">
                {ordered.map((e) => {
                  const pinned = MONEY_MOVED.has(e.category);
                  const link = affectedLink(e);
                  return (
                    <li
                      key={e.id}
                      className="fin-row"
                      data-edge={
                        pinned || e.severity === 'critical' || e.severity === 'high'
                          ? 'danger'
                          : 'warning'
                      }
                      aria-labelledby={`fin-ex-${e.id}`}
                    >
                      <div className="fin-row-main">
                        <span className="actions-row fin-tags">
                          {pinned ? (
                            <StatusBadge tone="danger" label="Money moved, not fulfilled" />
                          ) : (
                            <span className="fin-tag">{groupTitle(e.category)}</span>
                          )}
                          <StatusBadge {...EXCEPTION_SEVERITY[e.severity]} />
                          <StatusBadge {...EXCEPTION_STATUS[e.status]} />
                          {e.overdue ? <StatusBadge tone="danger" label="Overdue" /> : null}
                        </span>
                        <span className="row-title" id={`fin-ex-${e.id}`}>
                          {e.title}
                        </span>
                        <span className="caption">
                          Owner: {humanize(e.ownerQueue)} · opened{' '}
                          {formatAge(new Date(e.openedAt), now)}
                        </span>
                      </div>
                      {link ? (
                        <Link
                          className="button button-primary button-sm"
                          to={link.to}
                          aria-label={`${link.label}: ${e.title}`}
                        >
                          {link.label}
                        </Link>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            );
          }}
        </QueryBoundary>
      </div>
    </section>
  );
}

function UnknownOutcomesCard({
  payments,
  refunds,
}: {
  payments: ApiPagesResult<Schema<'PaymentAttempt'>>;
  refunds: ApiPagesResult<Schema<'Refund'>>;
}) {
  const now = useNow();
  const loaded = (payments.data?.length ?? 0) + (refunds.data?.length ?? 0);
  return (
    <section className="card card-flush fin-card" aria-labelledby="fin-unknown-title">
      <div className="card-head">
        <h3 id="fin-unknown-title">Unknown provider outcomes</h3>
        <span className="caption">A timeout is not proof of failure (SPK-PAY-007)</span>
      </div>
      <div className="fin-body">
        <QueryBoundary
          query={payments}
          label="unknown payment outcomes"
          isEmpty={() => loaded === 0 && !refunds.error && refunds.data !== undefined}
          empty={{
            title: 'No unknown outcomes',
            description: 'Every payment and refund the provider was asked for has a known outcome.',
          }}
          unavailableOffline={['reconciling']}
        >
          {(items) => (
            <ul className="fin-rows" aria-label="Unknown provider outcomes">
              {items.slice(0, 6).map((a) => (
                <li key={a.id} className="fin-row" data-edge="warning">
                  <div className="fin-row-main">
                    <span className="row-title">
                      Payment · {humanize(a.purpose)}
                      {a.provider ? ` · ${a.provider}` : ''}
                    </span>
                    <span className="caption">
                      Unknown {a.unknownSince ? formatAge(new Date(a.unknownSince), now) : ''} · do
                      not take payment again until reconciled
                    </span>
                  </div>
                  <span className="fin-amount">{formatMoney(a.amountMinor, a.currency)}</span>
                  <Link
                    className="button button-secondary button-sm"
                    to={`/finance/payments/${a.id}`}
                    aria-label={`Reconcile payment attempt of ${formatMoney(a.amountMinor, a.currency)}`}
                  >
                    Reconcile
                  </Link>
                </li>
              ))}
              {(refunds.data ?? []).slice(0, 6).map((r) => (
                <li key={r.id} className="fin-row" data-edge="warning">
                  <div className="fin-row-main">
                    <span className="row-title">Refund · {humanize(r.purpose)}</span>
                    <span className="caption">
                      <StatusBadge {...REFUND_STATUS.unknown} />
                    </span>
                  </div>
                  <span className="fin-amount">{formatMoney(r.amountMinor, r.currency)}</span>
                  <Link
                    className="button button-secondary button-sm"
                    to={`/finance/refunds/${r.id}`}
                    aria-label={`Reconcile refund of ${formatMoney(r.amountMinor, r.currency)}`}
                  >
                    Reconcile
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

const REMINDER_ACTION = 'finance.send_payment_reminder';
/** The API refuses a second reminder within a day (engineering placeholder, DEC-062). */
const REMINDER_INTERVAL_MS = 24 * 3_600_000;

function remindedRecently(o: Schema<'Obligation'>, now: Date): boolean {
  return (
    !!o.lastReminderAt &&
    now.getTime() - new Date(o.lastReminderAt).getTime() < REMINDER_INTERVAL_MS
  );
}

/** One reminder command for the card: rows and "Remind all" send through it, one at a time. */
function useReminders() {
  const remind = useApiCommand('post', '/obligations/{id}/reminders', {
    invalidate: [['api', '/obligations']],
  });
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const send = async (ids: readonly string[]) => {
    setFailed(null);
    for (const id of ids) {
      setBusy(id);
      try {
        await remind.submit({ path: { id }, body: {} });
        setSent((prev) => new Set([...prev, id]));
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'UNKNOWN';
        setFailed(`A reminder could not be sent (${code}).`);
        break;
      }
    }
    setBusy(null);
  };
  return { send, sent, failed, busy };
}

function PastDueCard({
  obligations,
  now,
}: {
  obligations: ApiPagesResult<Schema<'Obligation'>>;
  now: Date;
}) {
  const permissions = usePermissions();
  const canRemind = permissions.isPermitted(REMINDER_ACTION) === true;
  const reminders = useReminders();
  const due = pastDue(obligations.data ?? [], now).slice(0, 8);
  const toRemind = due.filter((o) => !remindedRecently(o, now) && !reminders.sent.has(o.id));
  return (
    <section className="card card-flush fin-card" aria-labelledby="fin-pastdue-title">
      <div className="card-head">
        <h3 id="fin-pastdue-title">Past due</h3>
        {canRemind && toRemind.length > 0 ? (
          <button
            type="button"
            className="button button-secondary button-sm"
            disabled={reminders.busy !== null}
            onClick={() => void reminders.send(toRemind.map((o) => o.id))}
          >
            Remind all {toRemind.length}
          </button>
        ) : null}
        <Link to="/finance/obligations" className="fin-head-link">
          All obligations <Icon name="chevron_right" size={18} />
        </Link>
      </div>
      <div className="fin-body">
        {reminders.failed ? (
          <p className="notice" role="alert">
            {reminders.failed}
          </p>
        ) : null}
        <QueryBoundary
          query={obligations}
          label="open obligations"
          isEmpty={(items) => pastDue(items, now).length === 0}
          empty={{
            title: 'Nothing past due',
            description: obligations.hasNextPage
              ? 'No open obligation loaded so far is past its due date.'
              : 'No open obligation is past its due date.',
          }}
        >
          {(items) => {
            const late = pastDue(items, now);
            return (
              <div
                className="fin-table fin-table-remind"
                role="table"
                aria-label="Past-due obligations"
              >
                <div className="fin-table-head" role="row">
                  <span role="columnheader">Account</span>
                  <span role="columnheader">For</span>
                  <span role="columnheader" className="num">
                    Remaining
                  </span>
                  <span role="columnheader">Late</span>
                  <span role="columnheader">Reminder</span>
                </div>
                {late.slice(0, 8).map((o) => {
                  const recent = remindedRecently(o, now) || reminders.sent.has(o.id);
                  return (
                    <div key={o.id} className="fin-table-row" role="row">
                      <span role="cell" className="row-title">
                        <Link to={`/finance/obligations/${o.id}`}>
                          <Debtor obligation={o} />
                        </Link>
                      </span>
                      <span role="cell" className="caption">
                        {o.description}
                      </span>
                      <span role="cell" className="num fin-amount">
                        {formatMoney(o.totals.remainingMinor, o.totals.currency)}
                      </span>
                      <span role="cell" className="fin-late">
                        {formatAge(new Date(o.dueAt), now)}
                      </span>
                      <span role="cell" className="fin-remind">
                        {recent ? (
                          <StatusBadge tone="success" label="Reminded" />
                        ) : canRemind ? (
                          <button
                            type="button"
                            className="button button-secondary button-sm"
                            aria-label={`Remind about ${o.description}`}
                            disabled={reminders.busy !== null}
                            onClick={() => void reminders.send([o.id])}
                          >
                            {reminders.busy === o.id ? 'Sending…' : 'Remind'}
                          </button>
                        ) : (
                          <span className="caption">—</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          }}
        </QueryBoundary>
        <p className="caption fin-remind-note">
          A reminder is an essential payment notice; which channels carry it is pending the
          operator&apos;s channel approval (DEC-062).
        </p>
      </div>
    </section>
  );
}

function pastDue(items: readonly Schema<'Obligation'>[], now: Date) {
  return items
    .filter((o) => o.status === 'open' && new Date(o.dueAt).getTime() < now.getTime())
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

function RefundsCard({ refunds }: { refunds: ApiPagesResult<Schema<'Refund'>> }) {
  const items = refunds.data ?? [];
  return (
    <section className="card card-flush fin-card" aria-labelledby="fin-refunds-title">
      <div className="card-head">
        <h3 id="fin-refunds-title">Refunds in flight</h3>
        {items.length > 0 ? (
          <span className="fin-total">
            {moneyLine(items)}
            {refunds.hasNextPage ? '+' : ''}
          </span>
        ) : null}
      </div>
      <div className="fin-body">
        <QueryBoundary
          query={refunds}
          label="refunds in flight"
          isEmpty={(list) => list.length === 0}
          empty={{
            title: 'No refunds in flight',
            description: 'Every requested refund has reached the provider and has an outcome.',
          }}
        >
          {(list) => (
            <ul className="fin-rows" aria-label="Refunds requested">
              {list.slice(0, 6).map((r) => (
                <li key={r.id} className="fin-row">
                  <div className="fin-row-main">
                    <span className="row-title">
                      {formatMoney(r.amountMinor, r.currency)} · {humanize(r.purpose)}
                    </span>
                    <span className="caption">{r.reason}</span>
                  </div>
                  <Link
                    className="button button-secondary button-sm"
                    to={`/finance/refunds/${r.id}`}
                    aria-label={`Open refund of ${formatMoney(r.amountMinor, r.currency)}`}
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

/** This month's reconciliation, in the currency the loaded money records carry. */
function ReconciliationCard({ currency, now }: { currency: string | null; now: Date }) {
  const today = now.toISOString().slice(0, 10);
  const from = dateToInstant(`${today.slice(0, 8)}01`);
  const to = dateToInstant(today, true);
  const report = useApiQuery({
    path: '/finance/reconciliation-report',
    request: { query: { from: from ?? '', to: to ?? '', currency: currency ?? '' } },
    enabled: currency !== null && from !== null && to !== null,
  });
  return (
    <section className="card card-dark fin-recon" aria-labelledby="fin-recon-title">
      <div className="fin-recon-head">
        <h3 id="fin-recon-title">Reconciliation</h3>
        <span className="caption">Month to date (UTC){currency ? ` · ${currency}` : ''}</span>
      </div>
      {currency === null ? (
        <p className="caption">
          No money is recorded yet. Reconciliation opens with a period and currency once payments
          exist.
        </p>
      ) : (
        <QueryBoundary query={report} label="reconciliation" empty={{ title: '', description: '' }}>
          {(r) => {
            const settled = r.settlements.length;
            const balanced = r.settlements.filter((s) => s.status === 'balanced').length;
            const pct = settled === 0 ? 0 : Math.round((balanced / settled) * 100);
            return (
              <>
                <span className="fin-recon-value">
                  {formatMoney(r.receipts.processorMinor + r.receipts.cashMinor, r.currency)}
                </span>
                <span className="caption">
                  received in {r.receipts.count} receipt{r.receipts.count === 1 ? '' : 's'}{' '}
                  (processor and cash)
                </span>
                <div
                  className="fin-recon-bar"
                  role="progressbar"
                  aria-label="Settlements balanced"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="fin-recon-line">
                  {settled === 0
                    ? 'No settlement or cash count recorded this month'
                    : `${balanced} of ${settled} settlement records balanced · ${settled - balanced} discrepanc${settled - balanced === 1 ? 'y' : 'ies'}`}
                </span>
                <dl className="fin-recon-facts">
                  <div>
                    <dt>Cash not reconciled</dt>
                    <dd>{formatMoney(r.cash.unreconciledMinor, r.currency)}</dd>
                  </div>
                  <div>
                    <dt>Refunds reserved</dt>
                    <dd>{formatMoney(r.refunds.reservedMinor, r.currency)}</dd>
                  </div>
                  <div>
                    <dt>Credits awaiting approval</dt>
                    <dd>{formatMoney(r.credits.pendingApprovalMinor, r.currency)}</dd>
                  </div>
                  <div>
                    <dt>Processor fees</dt>
                    <dd>{formatMoney(r.processorFeesMinor, r.currency)}</dd>
                  </div>
                </dl>
              </>
            );
          }}
        </QueryBoundary>
      )}
      <Link className="button button-lime" to="/finance/reconciliation">
        Open reconciliation
      </Link>
    </section>
  );
}

export function FinanceScreen() {
  const now = useNow();
  const exceptions = useApiPages({
    path: '/exceptions',
    request: { query: { queue: 'finance_operator', limit: 50 } },
  });
  const unknownPayments = useApiPages({
    path: '/payments',
    request: { query: { status: 'unknown', limit: 20 } },
  });
  const unknownRefunds = useApiPages({
    path: '/refunds',
    request: { query: { status: 'unknown', limit: 20 } },
  });
  const requestedRefunds = useApiPages({
    path: '/refunds',
    request: { query: { status: 'requested', limit: 20 } },
  });
  const obligations = useApiPages({
    path: '/obligations',
    request: { query: { status: 'open', limit: 50 } },
  });

  const finance = orderFinanceExceptions(exceptions.data ?? []);
  const moneyMoved = finance.filter((e) => MONEY_MOVED.has(e.category)).length;
  const unknownCount = (unknownPayments.data?.length ?? 0) + (unknownRefunds.data?.length ?? 0);
  const open = obligations.data ?? [];
  const late = pastDue(open, now);
  const currency =
    open[0]?.totals.currency ??
    unknownPayments.data?.[0]?.currency ??
    requestedRefunds.data?.[0]?.currency ??
    unknownRefunds.data?.[0]?.currency ??
    null;
  const dash = (loaded: unknown) => loaded === undefined;

  return (
    <section aria-labelledby="finance-title" className="fin">
      <PageHeader
        eyebrow={`Business · ${DATE_LINE.format(now)}`}
        title="Finance"
        titleId="finance-title"
        actions={
          <Link className="button button-secondary" to="/finance/accounting-exports">
            <Icon name="download" size={18} />
            Export for accounting
          </Link>
        }
      />
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <KpiRow label="Finance at a glance">
        <Kpi
          icon="error"
          tone="danger"
          label="Money moved, not fulfilled"
          value={dash(exceptions.data) ? '—' : count(moneyMoved, exceptions.hasNextPage)}
          sub="recovery required"
        />
        <Kpi
          icon="hourglass_empty"
          tone="warning"
          label="Unknown outcomes"
          value={
            dash(unknownPayments.data)
              ? '—'
              : count(unknownCount, unknownPayments.hasNextPage || unknownRefunds.hasNextPage)
          }
          sub="reconcile before any retry"
        />
        <Kpi
          icon="receipt_long"
          tone="info"
          label="Open balances"
          value={dash(obligations.data) ? '—' : count(open.length, obligations.hasNextPage)}
          sub={
            open.length > 0
              ? `${moneyLine(open.map((o) => ({ amountMinor: o.totals.remainingMinor, currency: o.totals.currency })))} remaining · ${late.length} past due`
              : 'open obligations'
          }
        />
        <Kpi
          icon="undo"
          tone="pending"
          label="Refunds in flight"
          value={
            dash(requestedRefunds.data)
              ? '—'
              : count(requestedRefunds.data?.length ?? 0, requestedRefunds.hasNextPage)
          }
          sub="requested, not yet executed"
        />
      </KpiRow>

      <div className="split">
        <div className="split-main">
          <ExceptionCard exceptions={exceptions} />
          <UnknownOutcomesCard payments={unknownPayments} refunds={unknownRefunds} />
          <PastDueCard obligations={obligations} now={now} />
        </div>
        <div className="split-side">
          <ReconciliationCard currency={currency} now={now} />
          <RefundsCard refunds={requestedRefunds} />
        </div>
      </div>

      <section className="fin-directory" aria-labelledby="finance-screens-title">
        <h3 id="finance-screens-title">Finance desk</h3>
        <ul className="fin-tiles" aria-label="Finance screens">
          {SCREENS.map((screen) => (
            <li key={screen.id} className="fin-tile">
              <span className="fin-tile-icon" aria-hidden="true">
                <Icon name={screen.icon} size={22} />
              </span>
              <div className="row-text">
                <Link className="row-title fin-tile-link" to={screen.to}>
                  {screen.title}
                </Link>
                <span className="caption">{screen.purpose}</span>
                <span className="label-caps">{screen.id}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="fin-directory" aria-labelledby="finance-conditional">
        <h3 id="finance-conditional">Conditional capabilities</h3>
        <ul className="fin-tiles fin-tiles-quiet" aria-labelledby="finance-conditional">
          {CONDITIONAL.map((screen) => (
            <li key={screen.id} className="fin-tile">
              <span className="fin-tile-icon" aria-hidden="true">
                <Icon name={CONDITIONAL_ICON[screen.slug] ?? 'tune'} size={22} />
              </span>
              <div className="row-text">
                <Link className="row-title fin-tile-link" to={screen.path}>
                  {screen.title}
                </Link>
                <span className="caption">{screen.purpose}</span>
                <span className="label-caps">{screen.id}, used only when turned on (DEC-016)</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <StateView
        variant="pending-decision"
        subject={PENDING.accounting.subject}
        decisions={PENDING.accounting.ids}
        owner={PENDING.accounting.owner}
      />
    </section>
  );
}
