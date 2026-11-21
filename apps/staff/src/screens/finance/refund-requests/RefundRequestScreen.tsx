/**
 * Staff S 4b: approve a refund request (from the family's "Cancel a week"; SPK-REG-010,
 * SPK-PAY-008, SPK-PAY-009, SPK-SUPPORT-002, §4.9, §4.11).
 *
 * The family's request is a support request (`GET /v1/cases/{id}`) naming the place and the
 * payment. The amount is worked out for staff by the cancellation preview
 * (`GET /v1/enrollments/{id}/cancellation-preview`): the item and its price, what the policy
 * gives back and whether it is permitted. Money is never optimistic: every button waits for the
 * service, the dialog is locked meanwhile, and each command carries its own idempotency key.
 *
 * - Refund: cancels the place under its policy (`POST /v1/enrollments/{id}/cancel` with the
 *   accepted consequence), requests the refund through the case (`POST /v1/cases/{id}/request-
 *   refund`, finance's normal command, linked to the case), offers the freed place to the next
 *   family on the waitlist when that is ticked (`POST /v1/waitlist-entries/{id}/offer`, a staff
 *   decision: auto-offering is a pending decision) and resolves the request, which the family
 *   sees in their app.
 * - Family credit: cancels the place and issues a credit for the amount (`POST /v1/credits`). The
 *   "+10%" bonus has no policy behind it: shown as proposed and not added.
 * - Change amount requires a note (the reason sent with the refund). Decline requires a note too.
 * - Who may: refunds and credits are finance commands (`finance.refund`, `finance.issue_credit`);
 *   a role without them sees the request with "Ask a manager". Amounts over $200 need a manager
 *   (general manager or administrator): a proposed threshold, not an approved policy.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePermissions } from '../../../api/permissions';
import { useApiQuery } from '../../../api/useApiQuery';
import { useKeyedCommands } from '../../../features/operations/commands';
import { nameOf, usePersonNames } from '../../../features/operations/context';
import { CommandError } from '../../../features/operations/feedback';
import { formatMoney, parseMinor } from '../../../features/operations/format';
import { useOperatingFacility } from '../../../features/operations/context';
import { Icon } from '../../../ui/Icon';
import { StateView } from '../../../ui/StateView';
import { DeskAvatar } from '../../arrival/desk/DeskAvatar';
import { deskClock } from '../../arrival/desk/deskModel';
import './refund-request.css';

type CaseDetail = Schema<'CaseDetail'>;

/** Proposed: refunds above this many minor units need a manager (not an approved policy). */
export const MANAGER_REFUND_THRESHOLD_MINOR = 20_000;
/** Proposed: the bonus a family credit would carry (not applied; no policy decides it). */
export const CREDIT_BONUS_BASIS_POINTS = 1_000;
const MANAGER_ROLES = ['general_manager', 'system_administrator'];

function relatedId(c: CaseDetail, type: string): string | null {
  return c.relatedRecords.find((r) => r.type === type)?.id ?? null;
}

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );

export function RefundRequestScreen() {
  const { caseId = '' } = useParams();
  const request = useApiQuery({ path: '/cases/{id}', request: { path: { id: caseId } } });
  return (
    <section className="rr-backdrop" aria-labelledby="rr-title">
      {request.data ? (
        <RefundRequest request={request.data} onChanged={() => void request.refetch()} />
      ) : (
        <div className="rr-dialog">
          <h1 id="rr-title" className="ops-sr">
            Refund request
          </h1>
          {request.error ? (
            <StateView
              variant="error"
              error={request.error}
              onRetry={() => void request.refetch()}
            />
          ) : (
            <div className="rr-skeleton" aria-busy="true">
              Loading the request…
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RefundRequest({ request, onChanged }: { request: CaseDetail; onChanged: () => void }) {
  const enrollmentId = relatedId(request, 'enrollment');
  const paymentId = relatedId(request, 'payment_attempt');
  const facility = useOperatingFacility();
  const permissions = usePermissions();
  const me = useApiQuery({ path: '/me' });
  const preview = useApiQuery({
    path: '/enrollments/{id}/cancellation-preview',
    request: { path: { id: enrollmentId ?? '' } },
    enabled: enrollmentId !== null,
  });
  const enrollment = useApiQuery({
    path: '/enrollments/{id}',
    request: { path: { id: enrollmentId ?? '' } },
    enabled: enrollmentId !== null,
  });
  const payment = useApiQuery({
    path: '/payments/{id}',
    request: { path: { id: paymentId ?? '' } },
    enabled: paymentId !== null,
  });
  const offeringId = preview.data?.existing.offeringId;
  const waitlist = useApiQuery({
    path: '/waitlist-entries',
    request: { query: { offeringId: offeringId ?? '' } },
    enabled: offeringId !== undefined,
  });
  const waiting =
    (waitlist.data as
      { items?: Schema<'WaitlistEntry'>[] } | Schema<'WaitlistEntry'>[] | undefined) ?? [];
  const entries = Array.isArray(waiting) ? waiting : (waiting.items ?? []);
  const next = entries
    .filter((e) => e.status === 'waiting')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
  const requester = request.openedBy.personId ?? request.subject.personId;
  const names = usePersonNames(
    [requester, request.subject.personId, next?.participantPersonId].filter(
      (id): id is string => typeof id === 'string',
    ),
  );

  const [giveBack, setGiveBack] = useState<'refund' | 'credit'>('refund');
  const [changing, setChanging] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [declining, setDeclining] = useState(false);
  const [offerNext, setOfferNext] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const commands = useKeyedCommands({
    invalidate: [
      ['api', '/cases/{id}'],
      ['api', '/credits'],
      ['api', '/refunds'],
    ],
  });

  const consequence = preview.data?.financialConsequence;
  const currency = consequence?.currency ?? preview.data?.existing.price?.currency ?? 'USD';
  const price = preview.data?.existing.price?.basePriceMinor ?? null;
  const worked = consequence?.amountMinor ?? null;
  const changed = changing ? parseMinor(amountText, currency) : null;
  const amount = changing ? changed : worked;
  const kept = price !== null && worked !== null ? price - worked : 0;
  const mayRefund = permissions.isPermitted('finance.refund') === true;
  const mayCredit = permissions.isPermitted('finance.issue_credit') === true;
  const isManager = (me.data?.principal.staffRoles ?? []).some((r) => MANAGER_ROLES.includes(r));
  const overThreshold = amount !== null && amount > MANAGER_REFUND_THRESHOLD_MINOR;
  const resolved = request.status === 'resolved' || request.status === 'closed';
  const noteMissing = (changing || declining) && note.trim().length === 0;
  // The provider keeps the card's details; the payment says only that a card paid.
  const card = 'the card';
  const blockedReason = resolved
    ? 'This request is already settled.'
    : !preview.data
      ? null
      : !preview.data.permitted
        ? 'The cancellation policy does not permit cancelling this place now.'
        : giveBack === 'refund' && !mayRefund
          ? 'Refunds are a finance command: ask a manager.'
          : giveBack === 'credit' && !mayCredit
            ? 'Credits are a finance command: ask a manager.'
            : overThreshold && !isManager
              ? 'Over $200 needs a manager (proposed rule).'
              : giveBack === 'refund' && !paymentId
                ? 'The request names no payment to refund.'
                : giveBack === 'refund' && payment.data && payment.data.status !== 'succeeded'
                  ? 'The payment it names has not succeeded, so there is nothing to refund.'
                  : null;

  const reason = (fallback: string) => (note.trim() ? note.trim() : fallback);
  const name = nameOf(names, requester ?? '', 'Family member');
  const childName = request.subject.personId ? nameOf(names, request.subject.personId) : '';

  const approve = async () => {
    if (!preview.data || !enrollment.data || amount === null || amount <= 0) return;
    const cancelled = await commands.run('cancel', 'post', '/enrollments/{id}/cancel', {
      path: { id: preview.data.enrollmentId },
      body: {
        reason: reason(`Family asked to cancel (request ${request.id.slice(0, 8)})`),
        expectedRevision: enrollment.data.revision,
        acceptedConsequence: {
          kind: preview.data.financialConsequence.kind,
          amountMinor: preview.data.financialConsequence.amountMinor,
          currency: preview.data.financialConsequence.currency,
        },
      },
    });
    if (!cancelled && commands.outcome('cancel').status !== 'success') return;
    if (giveBack === 'refund' && paymentId) {
      const refunded = await commands.run('refund', 'post', '/cases/{id}/request-refund', {
        path: { id: request.id },
        body: {
          paymentAttemptId: paymentId,
          amountMinor: amount,
          reason: reason('Refund as the cancellation policy allows'),
        },
      });
      if (!refunded) return;
    } else if (giveBack === 'credit' && enrollment.data.payerPersonId) {
      const credited = await commands.run('credit', 'post', '/credits', {
        body: {
          ownerPersonId: enrollment.data.payerPersonId,
          amountMinor: amount,
          currency,
          permittedUses: ['registration', 'obligation'],
          sourceKind: 'adjustment',
          reason: reason('Credit for a cancelled place'),
        },
      });
      if (!credited) return;
    }
    if (offerNext && next) {
      await commands.run('offer', 'post', '/waitlist-entries/{id}/offer', {
        path: { id: next.id },
        body: { reason: 'A place opened after a cancellation' },
      });
    }
    await commands.run('resolve', 'post', '/cases/{id}/transition', {
      path: { id: request.id },
      body: {
        event: 'resolve',
        expectedRevision: request.revision,
        resolution: {
          kind: giveBack === 'refund' ? 'action_taken' : 'information_provided',
          summary:
            giveBack === 'refund'
              ? `Refund of ${formatMoney(amount, currency)} requested to the card.`
              : `Family credit of ${formatMoney(amount, currency)} issued.`,
        },
      },
    });
    setDone(
      giveBack === 'refund'
        ? `Refund of ${formatMoney(amount, currency)} sent to ${card}. The family has been told.`
        : `Family credit of ${formatMoney(amount, currency)} issued. The family has been told.`,
    );
    onChanged();
  };

  const decline = async () => {
    if (note.trim().length === 0) return;
    const ok = await commands.run('decline', 'post', '/cases/{id}/transition', {
      path: { id: request.id },
      body: {
        event: 'resolve',
        expectedRevision: request.revision,
        resolution: { kind: 'no_action_needed', summary: note.trim() },
      },
    });
    if (ok) {
      setDone('Request declined. The family sees your note.');
      onChanged();
    }
  };

  const errors = (['cancel', 'refund', 'credit', 'offer', 'resolve', 'decline'] as const)
    .map((k) => ({ key: k, error: commands.outcome(k).error }))
    .filter((e): e is { key: (typeof e)['key']; error: ApiError } => e.error !== undefined);
  const busy = commands.anyPending;
  const bonus = worked !== null ? Math.round((worked * CREDIT_BONUS_BASIS_POINTS) / 10_000) : 0;

  return (
    <div
      className="rr-dialog"
      role="dialog"
      aria-labelledby="rr-title"
      aria-busy={busy || undefined}
    >
      <header className="rr-head">
        <DeskAvatar personId={requester ?? request.id} name={name} size={44} />
        <span>
          <h1 id="rr-title">Refund request · {name}</h1>
          <span className="caption">
            {preview.data?.existing.offeringName ?? request.title}
            {childName ? ` · ${childName.split(' ')[0]}` : ''} · asked{' '}
            {deskClock(request.createdAt, facility.timezone)}
          </span>
        </span>
        <span className="rr-status" data-tone={resolved ? 'success' : 'pending'}>
          {resolved ? '✓ Settled' : '◷ Pending'}
        </span>
      </header>
      <div className="rr-body">
        <blockquote className="rr-quote">“{request.description}”</blockquote>
        {preview.error ? (
          <CommandError
            error={preview.error}
            onRetry={() => void preview.refetch()}
            subject="The amount"
          />
        ) : !preview.data ? (
          <div className="rr-skeleton" aria-busy="true">
            Working out the amount…
          </div>
        ) : (
          <div className="rr-lines">
            <div className="rr-line">
              <span>
                {preview.data.existing.offeringName} · {shortDate(preview.data.existing.startsOn)}–
                {shortDate(preview.data.existing.endsOn)}
              </span>
              <b>{price !== null ? formatMoney(price, currency) : '—'}</b>
            </div>
            {kept > 0 ? (
              <div className="rr-line" data-tone="warning">
                <span>Kept under the cancellation policy</span>
                <b>−{formatMoney(kept, currency)}</b>
              </div>
            ) : null}
            <div className="rr-line" data-tone={preview.data.permitted ? 'success' : 'danger'}>
              <span>
                <b>Policy:</b> {consequence?.explanation ?? 'No refund rule'}{' '}
                {preview.data.permitted ? '✓' : '✕'}
              </span>
              <b>{worked !== null ? formatMoney(worked, currency) : '—'}</b>
            </div>
          </div>
        )}
        <span className="caption">Give back as</span>
        <div className="rr-segments" role="radiogroup" aria-label="Give back as">
          <button
            type="button"
            role="radio"
            aria-checked={giveBack === 'refund'}
            onClick={() => setGiveBack('refund')}
            disabled={busy || resolved}
          >
            To {card} · {amount !== null ? formatMoney(amount, currency) : '—'}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={giveBack === 'credit'}
            onClick={() => setGiveBack('credit')}
            disabled={busy || resolved}
          >
            Family credit · {amount !== null ? formatMoney(amount, currency) : '—'}{' '}
            <span className="rr-proposed" title="A credit bonus has no approved policy yet.">
              ◷ +{formatMoney(bonus, currency)} bonus proposed
            </span>
          </button>
        </div>
        {next ? (
          <label className="rr-waitlist">
            <input
              type="checkbox"
              checked={offerNext}
              onChange={(e) => setOfferNext(e.target.checked)}
              disabled={busy || resolved}
            />
            <Icon name="event_available" size={18} />
            The place goes to the waitlist ({nameOf(names, next.participantPersonId)} is next).
          </label>
        ) : (
          <p className="caption rr-waitlist">
            <Icon name="event_available" size={18} /> Nobody is waiting for this place.
          </p>
        )}
        {changing || declining ? (
          <div className="rr-change">
            {changing ? (
              <label>
                <span className="caption">Amount</span>
                <input
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-invalid={changed === null || undefined}
                />
              </label>
            ) : null}
            <label>
              <span className="caption">
                {declining ? 'Why it is declined (the family sees this)' : 'Note (required)'}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-invalid={noteMissing || undefined}
                rows={2}
              />
            </label>
          </div>
        ) : null}
        {blockedReason ? <p className="rr-blocked">{blockedReason}</p> : null}
        {done ? (
          <p className="rr-done" role="status">
            ✓ {done}
          </p>
        ) : null}
        {errors.map(({ key, error }) => (
          <CommandError key={key} error={error} onRetry={() => void commands.resend(key)} />
        ))}
      </div>
      <footer className="rr-foot">
        {declining ? (
          <button
            type="button"
            className="rr-text"
            onClick={() => setDeclining(false)}
            disabled={busy}
          >
            Back
          </button>
        ) : (
          <button
            type="button"
            className="rr-text"
            onClick={() => {
              setChanging((v) => !v);
              if (!changing && worked !== null) setAmountText((worked / 100).toFixed(2));
            }}
            disabled={busy || resolved}
          >
            {changing ? 'Use the worked-out amount' : 'Change amount'}
          </button>
        )}
        <span className="rr-spacer" />
        {declining ? (
          <button
            type="button"
            className="rr-button rr-danger"
            disabled={busy || note.trim().length === 0 || resolved}
            onClick={() => void decline()}
          >
            Decline request
          </button>
        ) : (
          <>
            <button
              type="button"
              className="rr-button rr-secondary"
              onClick={() => setDeclining(true)}
              disabled={busy || resolved}
            >
              Decline
            </button>
            <button
              type="button"
              className="rr-button rr-primary"
              disabled={
                busy ||
                blockedReason !== null ||
                noteMissing ||
                amount === null ||
                amount <= 0 ||
                done !== null
              }
              aria-busy={busy || undefined}
              onClick={() => void approve()}
            >
              {busy ? <span className="button-spinner" aria-hidden="true" /> : null}
              {giveBack === 'refund' ? 'Refund' : 'Credit'}{' '}
              {amount !== null ? formatMoney(amount, currency) : ''}
            </button>
          </>
        )}
      </footer>
      <Link to="/finance/refund-requests" className="rr-back">
        All refund requests
      </Link>
    </div>
  );
}

/** The open refund requests: support requests about payments that name a place. */
export function RefundRequestsScreen() {
  const cases = useApiQuery({
    path: '/cases',
    request: { query: { category: 'payment', limit: 50 } },
  });
  const open = (cases.data?.items ?? []).filter(
    (c) =>
      c.status !== 'resolved' &&
      c.status !== 'closed' &&
      c.relatedRecords.some((r) => r.type === 'enrollment'),
  );
  return (
    <section className="rr-list" aria-labelledby="rr-list-title">
      <h1 id="rr-list-title">Refund requests</h1>
      {cases.error ? (
        <StateView variant="error" error={cases.error} onRetry={() => void cases.refetch()} />
      ) : !cases.data ? (
        <div className="rr-skeleton" aria-busy="true">
          Loading requests…
        </div>
      ) : open.length === 0 ? (
        <StateView
          variant="empty"
          title="No refund requests waiting"
          description="Requests from families to cancel a place show here."
        />
      ) : (
        <ul>
          {open.map((c) => (
            <li key={c.id}>
              <Link to={`/finance/refund-requests/${c.id}`}>
                <b>{c.title}</b>
                <span className="caption">{c.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
