/**
 * SCR-S-36 Payment attempts and unknown outcomes (SPK-PAY-007, §4.11, §4.12, SPK-AT-006), three
 * views chosen with `?view=` (opaque, no personal data in the URL):
 *
 * - Exceptions (default): the finance operator's open exceptions
 *   (`GET /v1/exceptions?queue=finance_operator`, keyset pages newest first with "Load more"; the
 *   counts say "loaded so far" until the last page) grouped as unknown payment outcomes, unknown
 *   refund outcomes, checkouts needing recovery, provider events that match no attempt, and other
 *   finance exceptions, each with severity and status as text, age, owner queue, deadline, and a
 *   link to the affected record to reconcile it. Empty says there are no unknown outcomes.
 * - Payment attempts (`GET /v1/payments`, FIN-02): every attempt by state (including `unknown`),
 *   purpose and payer, in keyset pages; an attempt also opens by its reference.
 * - Provider events (`GET /v1/provider-events`, K-08): what the inbox received with its signature
 *   verification state, processing state, attempts and last error, never the payload (§4.14);
 *   duplicates and reordered deliveries are absorbed by the inbox (one row per provider event id).
 *
 * Provider selection is pending DEC-019 and the classification target DEC-039.
 */
import type { Schema } from '@sportspark/api-client';
import { formatAge } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { SelectField, TextField } from '../../features/registration-finance/fields';
import { PersonReferenceField } from '../../features/registration-finance/PersonSearch';
import { formatInstant, humanize, shortRef } from '../../features/registration-finance/format';
import {
  EXCEPTION_SEVERITY,
  EXCEPTION_STATUS,
  PAYMENT_STATUS,
  PROVIDER_EVENT_STATUS,
} from '../../features/registration-finance/labels';
import { PaymentAttemptList } from '../../features/registration-finance/PaymentAttempts';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type OperationalException = Schema<'OperationalException'>;
type ExceptionStatus = Schema<'ExceptionStatus'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EXCEPTION_GROUPS: readonly { title: string; categories: readonly string[] }[] = [
  {
    title: 'Unknown payment outcomes',
    categories: ['finance.unknown_payment_outcome', 'finance.payment_evidence_conflict'],
  },
  {
    title: 'Unknown refund outcomes',
    categories: ['finance.unknown_refund_outcome', 'finance.refund_evidence_conflict'],
  },
  {
    title: 'Checkouts needing recovery',
    categories: ['finance.fulfillment_incomplete', 'finance.compensation_failed'],
  },
  {
    title: 'Provider events without a matching attempt',
    categories: ['finance.unmatched_provider_event'],
  },
  {
    title: 'Other finance exceptions',
    categories: [
      'finance.installment_failed',
      'finance.overpayment_review',
      'finance.settlement_discrepancy',
    ],
  },
];

function detail(exception: OperationalException, key: string): string | null {
  const value = exception.details[key];
  return typeof value === 'string' ? value : null;
}

/** Where to act on the affected record; null when the API publishes no read for it. */
export function affectedLink(
  exception: OperationalException,
): { to: string; label: string } | null {
  const affected = exception.affected;
  if (!affected) return null;
  switch (affected.type) {
    case 'payment_attempt':
      return { to: `/finance/payments/${affected.id}`, label: 'Open the payment attempt' };
    case 'refund_attempt':
      return { to: `/finance/refunds/${affected.id}`, label: 'Open the refund' };
    case 'checkout':
      return { to: `/finance/checkouts/${affected.id}`, label: 'Open the checkout recovery' };
    case 'credit':
      return { to: `/finance/credits/${affected.id}`, label: 'Open the credit' };
    case 'installment': {
      const obligationId = detail(exception, 'obligationId');
      return obligationId
        ? { to: `/finance/obligations/${obligationId}`, label: 'Open the obligation' }
        : null;
    }
    case 'settlement_reconciliation':
      return { to: '/finance/reconciliation', label: 'Open reconciliation' };
    case 'inbox_event':
      return { to: '/finance/payments?view=events', label: 'Open the provider events' };
    default:
      return null;
  }
}

function ExceptionRow({ exception }: { exception: OperationalException }) {
  const now = useNow();
  const link = affectedLink(exception);
  return (
    <li aria-labelledby={`exception-${exception.id}`}>
      <div className="row-text">
        <span className="row-title" id={`exception-${exception.id}`}>
          {exception.title}
        </span>
        <span>
          <StatusBadge {...EXCEPTION_SEVERITY[exception.severity]} />{' '}
          <StatusBadge {...EXCEPTION_STATUS[exception.status]} />
          {exception.overdue ? (
            <>
              {' '}
              <StatusBadge tone="danger" label="Overdue" />
            </>
          ) : null}
        </span>
        <span className="caption">
          Opened {formatAge(new Date(exception.openedAt), now)} · owner queue{' '}
          {humanize(exception.ownerQueue)} · deadline {formatInstant(exception.deadlineAt)}
        </span>
        {link ? (
          <Link to={link.to}>{link.label}</Link>
        ) : (
          <span className="caption">
            The affected {exception.affected ? humanize(exception.affected.type) : 'record'} has no
            read in the API.
          </span>
        )}
      </div>
    </li>
  );
}

function ExceptionsView() {
  // '' asks for the API's active set (open and acknowledged): an acknowledged unknown outcome is
  // still unresolved and must stay visible (SCR-S-36).
  const [status, setStatus] = useState<ExceptionStatus | ''>('');
  // K-10 (§4.5): the queue is the API's keyset pages, newest first, with "Load more".
  const exceptions = useApiPages({
    path: '/exceptions',
    request: { query: { queue: 'finance_operator', limit: 50, ...(status ? { status } : {}) } },
  });
  const more = exceptions.hasNextPage;
  return (
    <>
      <SelectField
        label="Exceptions"
        value={status}
        placeholder="Open or acknowledged"
        onChange={(v) => setStatus(v as ExceptionStatus | '')}
        options={Object.entries(EXCEPTION_STATUS).map(([value, badge]) => ({
          value,
          label: badge.label,
        }))}
      />
      <QueryBoundary
        query={exceptions}
        label="finance exceptions"
        // "None" is said only once every page has loaded: an empty first page with more to load
        // shows the groups and "Load more" instead.
        isEmpty={(items) =>
          !more && items.filter((e) => e.category.startsWith('finance.')).length === 0
        }
        empty={
          status === ''
            ? {
                title: 'No unknown outcomes',
                description:
                  'There are no open or acknowledged unknown or conflicting payment or refund outcomes, and no checkout needs recovery.',
              }
            : {
                title: `No ${EXCEPTION_STATUS[status].label} finance exceptions`,
                description: 'No finance exception has this status.',
              }
        }
        unavailableOffline={['reconciling']}
      >
        {(loaded) => (
          <>
            {more ? (
              <p className="caption" role="status">
                Counts are of the exceptions loaded so far, newest first; more exist under “Load
                more finance exceptions”.
              </p>
            ) : null}
            {[
              ...EXCEPTION_GROUPS,
              // Every finance exception is shown: a category not listed above (for example one a
              // later release adds) is never dropped.
              {
                title: 'Finance exceptions of another kind',
                categories: loaded
                  .map((e) => e.category)
                  .filter(
                    (c) =>
                      c.startsWith('finance.') &&
                      !EXCEPTION_GROUPS.some((g) => g.categories.includes(c)),
                  ),
              },
            ].map((group) => {
              const items = loaded.filter((e) => group.categories.includes(e.category));
              if (group.title === 'Finance exceptions of another kind' && items.length === 0)
                return null;
              return (
                <section key={group.title} className="rf-panel" aria-label={group.title}>
                  <h3>
                    {group.title} ({items.length}
                    {more ? ' loaded so far' : ''})
                  </h3>
                  {items.length === 0 ? (
                    <p className="caption">{more ? 'None loaded so far.' : 'None.'}</p>
                  ) : (
                    <ul className="list" aria-label={`${group.title}: items`}>
                      {items.map((exception) => (
                        <ExceptionRow key={exception.id} exception={exception} />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </>
        )}
      </QueryBoundary>
      <LoadMore pages={exceptions} label="finance exceptions" />
    </>
  );
}

type AttemptStatus = Schema<'PaymentAttemptStatus'>;
type Purpose = Schema<'PaymentAttemptPurpose'>;
const UUID_RE = UUID;
const PURPOSES: readonly Purpose[] = [
  'checkout',
  'obligation',
  'contribution',
  'installment',
  'pos_sale',
];

function AttemptsView() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<AttemptStatus | ''>('unknown');
  const [purpose, setPurpose] = useState<Purpose | ''>('');
  const [payer, setPayer] = useState('');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const payerId = UUID_RE.test(payer.trim()) ? payer.trim() : '';
  return (
    <>
      <form
        noValidate
        aria-label="Open a payment attempt"
        className="rf-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!UUID_RE.test(reference.trim())) {
            setReferenceError('Enter a payment attempt reference.');
            return;
          }
          setReferenceError(null);
          navigate(`/finance/payments/${reference.trim()}`);
        }}
      >
        <TextField
          label="Payment attempt reference"
          value={reference}
          onChange={setReference}
          error={referenceError}
        />
        <Button type="submit" variant="secondary">
          Open the attempt
        </Button>
      </form>
      <div className="rf-grid">
        <SelectField
          label="Attempt state"
          value={status}
          placeholder="Every state"
          onChange={(v) => setStatus(v as AttemptStatus | '')}
          options={Object.entries(PAYMENT_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
        <SelectField
          label="Purpose"
          value={purpose}
          placeholder="Every purpose"
          onChange={(v) => setPurpose(v as Purpose | '')}
          options={PURPOSES.map((p) => ({ value: p, label: humanize(p) }))}
        />
        <PersonReferenceField
          label="Payer reference"
          person="Payer"
          value={payer}
          onChange={setPayer}
          hint="A person reference narrows to one payer."
        />
      </div>
      <PaymentAttemptList
        filter={{
          ...(status ? { status } : {}),
          ...(purpose ? { purpose } : {}),
          ...(payerId ? { payerPersonId: payerId } : {}),
        }}
      />
    </>
  );
}

type EventStatus = Schema<'ProviderEventStatus'>;

function EventsView({ initialProvider }: { initialProvider: string }) {
  const [status, setStatus] = useState<EventStatus | ''>('');
  const [provider, setProvider] = useState(initialProvider);
  const [eventType, setEventType] = useState('');
  const events = useApiPages({
    path: '/provider-events',
    request: {
      query: {
        limit: 50,
        ...(status ? { status } : {}),
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(eventType.trim() ? { eventType: eventType.trim() } : {}),
      },
    },
  });
  return (
    <>
      <p className="caption">
        What the inbox received from providers, newest first. Payloads are never shown (§4.14). A
        duplicate or reordered delivery of the same provider event is processed once.
      </p>
      <div className="rf-grid">
        <SelectField
          label="Processing state"
          value={status}
          placeholder="Every state"
          onChange={(v) => setStatus(v as EventStatus | '')}
          options={Object.entries(PROVIDER_EVENT_STATUS).map(([value, badge]) => ({
            value,
            label: badge.label,
          }))}
        />
        <TextField label="Provider" value={provider} onChange={setProvider} />
        <TextField label="Event type" value={eventType} onChange={setEventType} />
      </div>
      <QueryBoundary
        query={events}
        label="provider events"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No provider events', description: 'No provider event matches.' }}
      >
        {(items) => (
          <ul className="list" aria-label="Provider events">
            {items.map((event) => (
              <li key={event.id} aria-labelledby={`event-${event.id}`}>
                <div className="row-text">
                  <span className="row-title" id={`event-${event.id}`}>
                    {event.provider} · {event.eventType}
                  </span>
                  <span className="caption">
                    Provider event {event.providerEventId} · received{' '}
                    {formatInstant(event.receivedAt, 'UTC')} · processed{' '}
                    {formatInstant(event.processedAt, 'UTC')} · {event.attempts} attempt(s)
                  </span>
                  {event.lastError ? (
                    <span className="caption">Last error: {event.lastError}</span>
                  ) : null}
                  <span className="caption">Inbox record {shortRef(event.id)}</span>
                </div>
                <span>
                  <StatusBadge
                    tone={event.signatureVerified ? 'success' : 'danger'}
                    label={
                      event.signatureVerified ? 'Signature verified' : 'Signature not verified'
                    }
                  />{' '}
                  <StatusBadge {...PROVIDER_EVENT_STATUS[event.status]} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={events} label="provider events" />
    </>
  );
}

const VIEWS = [
  { id: 'exceptions', label: 'Unknown outcomes and exceptions' },
  { id: 'attempts', label: 'Payment attempts' },
  { id: 'events', label: 'Provider events' },
] as const;
type View = (typeof VIEWS)[number]['id'];

export function PaymentExceptionsScreen() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('view');
  const view: View = VIEWS.some((v) => v.id === requested) ? (requested as View) : 'exceptions';
  return (
    <section aria-labelledby="payments-title">
      <h2 id="payments-title">Payment attempts and unknown outcomes</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <p>
        A timeout is not proof of failure. Reconcile an unknown outcome from the provider&apos;s
        evidence before anything else risks charging the customer again (SPK-PAY-007).
      </p>
      <div className="rf-actions" role="group" aria-label="Show">
        {VIEWS.map((v) => (
          <Button
            key={v.id}
            variant={view === v.id ? 'primary' : 'secondary'}
            aria-pressed={view === v.id}
            onClick={() => setParams(v.id === 'exceptions' ? {} : { view: v.id })}
          >
            {v.label}
          </Button>
        ))}
      </div>
      {view === 'exceptions' ? <ExceptionsView /> : null}
      {view === 'attempts' ? <AttemptsView /> : null}
      {view === 'events' ? <EventsView initialProvider={params.get('provider') ?? ''} /> : null}
      <StateView
        variant="pending-decision"
        subject="The classification target for unresolved payment events"
        decisions={PENDING.eventClassification.ids}
        owner={PENDING.eventClassification.owner}
      />
    </section>
  );
}
