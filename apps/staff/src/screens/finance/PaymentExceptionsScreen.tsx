/**
 * SCR-S-36 Payment attempts and unknown outcomes, queue (SPK-PAY-007, §4.11, §4.12, SPK-AT-006):
 * the finance operator's open exceptions (`GET /v1/exceptions?queue=finance_operator`) grouped as
 * unknown payment outcomes, unknown refund outcomes, checkouts needing recovery, provider events
 * that match no attempt, and other finance exceptions. Each shows severity and status as text,
 * age, owner queue, deadline, and links to the affected record to reconcile it.
 *
 * The API has no list of payment attempts by state, so this queue is built from the exceptions the
 * finance module raises when an outcome becomes unknown or conflicting; an attempt can also be
 * opened by its reference. When the queue is empty the screen says there are no unknown outcomes.
 * Provider selection is pending DEC-019 and the classification target DEC-039.
 */
import type { Schema } from '@sportspark/api-client';
import { formatAge } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { SelectField, TextField } from '../../features/registration-finance/fields';
import { formatInstant, humanize } from '../../features/registration-finance/format';
import { EXCEPTION_SEVERITY, EXCEPTION_STATUS } from '../../features/registration-finance/labels';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
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
            read in the API (for provider events, the inbox is not published).
          </span>
        )}
      </div>
    </li>
  );
}

export function PaymentExceptionsScreen() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ExceptionStatus | ''>('open');
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const exceptions = useApiQuery({
    path: '/exceptions',
    request: { query: { queue: 'finance_operator', limit: 200, ...(status ? { status } : {}) } },
  });
  return (
    <section aria-labelledby="payments-title">
      <h2 id="payments-title">Payment attempts and unknown outcomes</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <p>
        A timeout is not proof of failure. Reconcile an unknown outcome from the provider&apos;s
        evidence before anything else risks charging the customer again (SPK-PAY-007).
      </p>
      <form
        noValidate
        aria-label="Open a payment attempt"
        className="rf-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!UUID.test(reference.trim())) {
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
      <SelectField
        label="Exceptions"
        value={status}
        placeholder="All statuses"
        onChange={(v) => setStatus(v as ExceptionStatus | '')}
        options={Object.entries(EXCEPTION_STATUS).map(([value, badge]) => ({
          value,
          label: badge.label,
        }))}
      />
      <QueryBoundary
        query={exceptions}
        label="finance exceptions"
        isEmpty={(page) => page.items.filter((e) => e.category.startsWith('finance.')).length === 0}
        empty={{
          title: 'No unknown outcomes',
          description:
            'There are no unknown or conflicting payment or refund outcomes and no checkout needs recovery.',
        }}
        unavailableOffline={['reconciling']}
      >
        {(page) => (
          <>
            {EXCEPTION_GROUPS.map((group) => {
              const items = page.items.filter((e) => group.categories.includes(e.category));
              return (
                <section key={group.title} className="rf-panel" aria-label={group.title}>
                  <h3>
                    {group.title} ({items.length})
                  </h3>
                  {items.length === 0 ? (
                    <p className="caption">None.</p>
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
            {page.nextCursor ? (
              <StateView
                variant="empty"
                title="More exceptions exist"
                description="Only the first 200 are shown."
              />
            ) : null}
          </>
        )}
      </QueryBoundary>
      <StateView
        variant="pending-decision"
        subject="The classification target for unresolved payment events"
        decisions={PENDING.eventClassification.ids}
        owner={PENDING.eventClassification.owner}
      />
    </section>
  );
}
