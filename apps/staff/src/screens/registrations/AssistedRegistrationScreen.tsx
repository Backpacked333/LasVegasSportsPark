/**
 * SCR-S-25 Assisted registration (SPK-REG-009, SPK-IAM-002, SPK-PAY-012, SPK-REG-004,
 * SPK-PAY-002, SPK-REG-006, SPK-PAY-007): staff run the same commands the customer app uses, in
 * the same order: open a household basket (`POST /v1/baskets` naming the household adult), add
 * lines (each with its own participant, eligibility, price and policy), hold capacity
 * (server-owned expiry), price it (`POST /v1/registration-quotes`), then check out
 * (`POST /v1/registration-checkouts`). The API records the staff actor apart from the participant,
 * payer and form signer; nothing here signs a guardian acknowledgment.
 *
 * - Fulfillment is all-or-nothing: partial fulfillment needs the customer's own acceptance and its
 *   configuration is pending DEC-026, so it is not offered on the customer's behalf.
 * - Card payment needs a provider's hosted fields (pending DEC-019); staff never type card data.
 *   Cash and external tenders carry evidence; the approved procedure is pending DEC-009/POL-018,
 *   and the API checks tender permissions. Installment plans are pending DEC-073.
 * - QUOTE_EXPIRED offers a new quote; PAYMENT_OUTCOME_UNKNOWN and `recovery_required` are recovery
 *   states that link to SCR-S-36 and never invite a second payment.
 * - Basket to checkout (FIN-04, ENR-06, SPK-UX-001): once checkout starts, the basket names its
 *   order (`orderRef`) and the checkout operation (`lastOperationId`). After a reload the screen
 *   follows that operation (`GET /v1/operations/{id}`) to its outcome, opens the checkout it
 *   names, and lists the order's payment attempts (`GET /v1/payments?orderId=`), so an unknown
 *   payment is never mistaken for a failure or a success and is never paid twice.
 * - People are found by name or contact (`GET /v1/people`, names only) or entered by reference.
 * - The intents offered for a line are the offering's (`GET /v1/offerings/{id}/registration-
 *   options`, ENR-05) with the participant's read-only eligibility before anything is added.
 * - Offline: commands are disabled and what was typed is kept.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useOperation } from '../../api/useOperation';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { EligibilityView } from '../../features/registration-finance/Eligibility';
import { useFacilities } from '../../features/registration-finance/facilities';
import {
  Facts,
  SelectField,
  TextArea,
  TextField,
} from '../../features/registration-finance/fields';
import {
  formatInstant,
  formatMoney,
  humanize,
  shortRef,
} from '../../features/registration-finance/format';
import {
  BASKET_STATUS,
  CHECKOUT_STATUS,
  HOLD_STATUS,
  LINE_OUTCOME,
  OPERATION_STATUS,
  PAYMENT_STATUS,
  QUOTE_STATUS,
  REGISTRATION_INTENT,
  TENDER_KIND,
} from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { OfferingPicker } from '../../features/registration-finance/OfferingPicker';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PaymentAttemptList } from '../../features/registration-finance/PaymentAttempts';
import { PersonSearch } from '../../features/registration-finance/PersonSearch';
import { PENDING } from '../../features/registration-finance/pending';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { outcomePending, useSameRequest } from '../../features/registration-finance/sameRequest';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Basket = Schema<'Basket'>;
type Quote = Schema<'Quote'>;
type Checkout = Schema<'Checkout'>;
type Intent = Schema<'RegistrationIntent'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASKET_KEY = ['api', '/baskets/{id}'] as const;
/** Basket states in which pricing, payment or its outcome is shown. */
const PRICED_STATUSES: readonly Basket['status'][] = [
  'held',
  'checking_out',
  'fulfilled',
  'partially_fulfilled',
];

/** Reload the basket after a stale or invalid answer; the form keeps what was typed. */
function useBasketReload(reset: () => void) {
  const queryClient = useQueryClient();
  return () => {
    reset();
    void queryClient.invalidateQueries({ queryKey: BASKET_KEY });
  };
}

/** A person reference field that shows whose record it is once the reference is complete. */
function PersonReferenceField({
  label,
  value,
  onChange,
  error,
  required,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
}) {
  const valid = UUID.test(value.trim());
  return (
    <div>
      <TextField
        label={label}
        required={required}
        hint={hint}
        value={value}
        onChange={onChange}
        error={error}
      />
      {valid ? (
        <p className="caption" aria-live="polite">
          {label}: <PersonName id={value.trim()} />
        </p>
      ) : (
        <PersonSearch label={label} onChoose={onChange} />
      )}
    </div>
  );
}

function StartBasket() {
  const navigate = useNavigate();
  const online = useOnline();
  const [owner, setOwner] = useState('');
  const [payer, setPayer] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const create = useApiCommand('post', '/baskets');
  const server = fieldErrorsOf(create.error);
  return (
    <section className="rf-panel" aria-labelledby="start-basket-title">
      <h3 id="start-basket-title">Start a household basket</h3>
      <p className="caption">
        Name the household adult the registration belongs to. The participant, payer and any form
        signer stay distinct from you, the staff actor, who is recorded separately (SPK-REG-009).
        Search by name or contact, or find people in <Link to="/people">People and families</Link>.
      </p>
      <form
        noValidate
        aria-label="Start a household basket"
        onSubmit={(event) => {
          event.preventDefault();
          const errors: Record<string, string> = {};
          if (!UUID.test(owner.trim()))
            errors.ownerPersonId = 'Enter the household adult’s person reference.';
          if (payer.trim() && !UUID.test(payer.trim()))
            errors.payerPersonId = 'Enter a person reference or leave empty.';
          setLocal(errors);
          if (Object.keys(errors).length > 0) return;
          create
            .submit({
              body: {
                ownerPersonId: owner.trim(),
                ...(payer.trim() ? { payerPersonId: payer.trim() } : {}),
                fulfillmentMode: 'all_or_nothing',
                acceptPartialFulfillment: false,
              },
            })
            .then((basket) => navigate(`/registrations/assisted/${basket.id}`))
            .catch(() => undefined);
        }}
      >
        <div className="rf-grid">
          <PersonReferenceField
            label="Household adult"
            required
            value={owner}
            onChange={setOwner}
            error={local.ownerPersonId ?? server.ownerPersonId}
          />
          <PersonReferenceField
            label="Payer"
            hint="Leave empty when the household adult pays."
            value={payer}
            onChange={setPayer}
            error={local.payerPersonId ?? server.payerPersonId}
          />
        </div>
        <p className="caption">
          Fulfillment: all or nothing. Partial fulfillment needs the customer&apos;s own acceptance
          and is pending {PENDING.basketFulfillment.ids.join(', ')} (owner:{' '}
          {PENDING.basketFulfillment.owner}).
        </p>
        <div className="rf-actions">
          <Button type="submit" busy={create.isProcessing} disabled={!online}>
            Start basket
          </Button>
        </div>
        <OfflineCaption action="starting a basket" />
        <CommandError error={create.error} />
      </form>
    </section>
  );
}

function LineItem({ basket, line }: { basket: Basket; line: Basket['lines'][number] }) {
  const online = useOnline();
  const remove = useApiCommand('post', '/baskets/{id}/lines/{lineId}/remove', {
    invalidate: [BASKET_KEY],
  });
  const reloadAfterRemove = useBasketReload(remove.reset);
  const forms = line.policies.requiredFormPolicyVersionIds.length;
  return (
    <li aria-labelledby={`line-${line.id}`}>
      <div className="row-text">
        <span className="row-title" id={`line-${line.id}`}>
          <PersonName id={line.participantPersonId} fallback="Participant" />:{' '}
          <OfferingName id={line.offeringId} />
        </span>
        <span className="caption">
          {REGISTRATION_INTENT[line.intent]} · quantity {line.quantity} · price{' '}
          {line.price ? formatMoney(line.price.basePriceMinor, line.price.currency) : 'not priced'}
          {line.requiresApproval ? ' · needs approval before payment' : ''}
        </span>
        <StatusBadge {...LINE_OUTCOME[line.outcome]} />
        {line.outcomeReason ? <span className="caption">{line.outcomeReason}</span> : null}
        <EligibilityView result={line.eligibility} label="Line eligibility" />
        {forms > 0 ? (
          <span className="caption">
            {forms} required form(s): signed by the participant or a guardian in the customer app.
            Staff never sign a guardian acknowledgment (SPK-REG-009).
          </span>
        ) : null}
        {line.enrollmentId ? (
          <Link to={`/registrations/enrollments/${line.enrollmentId}`}>Open the enrollment</Link>
        ) : null}
      </div>
      {basket.status === 'open' ? (
        <Button
          variant="secondary"
          busy={remove.isProcessing}
          disabled={!online}
          aria-label={`Remove line ${line.sequence}`}
          onClick={() => {
            remove
              .submit({
                path: { id: basket.id, lineId: line.id },
                body: { expectedRevision: basket.revision },
              })
              .catch(() => undefined);
          }}
        >
          Remove
        </Button>
      ) : null}
      <CommandError error={remove.error} onReload={reloadAfterRemove} />
    </li>
  );
}

function AddLine({ basket }: { basket: Basket }) {
  const online = useOnline();
  const [participant, setParticipant] = useState('');
  const [offeringId, setOfferingId] = useState('');
  const [intent, setIntent] = useState<Intent | ''>('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const add = useApiCommand('post', '/baskets/{id}/lines', { invalidate: [BASKET_KEY] });
  const reloadAfterAdd = useBasketReload(add.reset);
  const server = fieldErrorsOf(add.error);
  const participantId = UUID.test(participant.trim()) ? participant.trim() : '';
  // ENR-05: what the offering accepts and the participant's read-only eligibility per intent.
  const options = useApiQuery({
    path: '/offerings/{id}/registration-options',
    request: {
      path: { id: offeringId },
      query: participantId ? { participantPersonIds: participantId } : {},
    },
    enabled: offeringId !== '',
  });
  const available = options.data?.availableIntents;
  const intentChoices = (available ?? (Object.keys(REGISTRATION_INTENT) as Intent[])).map(
    (value) => ({ value, label: REGISTRATION_INTENT[value] }),
  );
  const notAccepted = intent !== '' && available !== undefined && !available.includes(intent);
  const preview =
    intent && participantId
      ? options.data?.participants
          .find((p) => p.personId === participantId)
          ?.intents.find((i) => i.intent === intent)?.eligibility
      : undefined;
  return (
    <form
      noValidate
      aria-label="Add a participant and offering"
      onSubmit={(event) => {
        event.preventDefault();
        const errors: Record<string, string> = {};
        if (!UUID.test(participant.trim()))
          errors.participantPersonId = 'Enter the participant’s person reference.';
        if (!offeringId) errors.offeringId = 'Choose an offering.';
        if (!intent) errors.intent = 'Choose the registration intent.';
        else if (notAccepted) errors.intent = 'This offering does not accept this intent.';
        setLocal(errors);
        if (Object.keys(errors).length > 0 || !intent) return;
        add
          .submit({
            path: { id: basket.id },
            body: {
              participantPersonId: participant.trim(),
              offeringId,
              intent,
              quantity: 1,
              expectedRevision: basket.revision,
            },
          })
          .then(() => {
            setParticipant('');
            setOfferingId('');
          })
          .catch(() => undefined);
      }}
    >
      <h4>Add a participant and offering</h4>
      <div className="rf-grid">
        <PersonReferenceField
          label="Participant"
          required
          value={participant}
          onChange={setParticipant}
          error={local.participantPersonId ?? server.participantPersonId}
        />
        <SelectField
          label="Registration intent"
          required
          value={intent}
          placeholder="Choose an intent"
          onChange={(v) => setIntent(v as Intent | '')}
          options={intentChoices}
          error={
            local.intent ??
            server.intent ??
            (notAccepted ? 'This offering does not accept this intent.' : null)
          }
        />
      </div>
      <OfferingPicker label="Offering" value={offeringId} onChange={setOfferingId} />
      {local.offeringId ? <p className="rf-error">{local.offeringId}</p> : null}
      {offeringId && options.error ? (
        <p className="caption">
          The intents this offering accepts could not be read ({options.error.code}); the API checks
          the intent when the line is added.
        </p>
      ) : null}
      {available ? (
        <p className="caption">
          This offering accepts: {available.map((i) => REGISTRATION_INTENT[i]).join(', ')}.
        </p>
      ) : null}
      {preview ? (
        <EligibilityView result={preview} label="Eligibility before adding (read only)" />
      ) : null}
      <div className="rf-actions">
        <Button type="submit" busy={add.isProcessing} disabled={!online}>
          Add to basket
        </Button>
      </div>
      <OfflineCaption action="adding a line" />
      <CommandError error={add.error} onReload={reloadAfterAdd} />
    </form>
  );
}

function QuoteView({ quote }: { quote: Quote }) {
  const now = useNow();
  const expired = quote.status === 'expired' || new Date(quote.expiresAt) <= now;
  return (
    <div role="group" aria-label="Quote">
      <p>
        <StatusBadge {...QUOTE_STATUS[expired ? 'expired' : quote.status]} />{' '}
        <span className="caption">
          Quote {shortRef(quote.id)} valid until {formatInstant(quote.expiresAt)} (server-owned)
        </span>
      </p>
      <div className="rf-table-wrap">
        <table className="rf-table" aria-label="Quote lines">
          <thead>
            <tr>
              <th scope="col">Participant and item</th>
              <th scope="col">Base price</th>
              <th scope="col">Discounts</th>
              <th scope="col">Taxes and fees</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <PersonName id={line.participantPersonId} fallback="Participant" />:{' '}
                  {line.description}
                </td>
                <td>{formatMoney(line.baseAmountMinor, line.currency)}</td>
                <td>
                  {formatMoney(line.discountMinor, line.currency)}
                  {line.discounts.map((d) => (
                    <div className="caption" key={d.discountDefinitionId}>
                      {d.name}: {d.explanation.join(' ')}
                    </div>
                  ))}
                </td>
                <td>
                  {formatMoney(line.taxMinor + line.feeMinor, line.currency)}
                  {line.charges.map((c) => (
                    <div className="caption" key={c.code}>
                      {c.label}: {formatMoney(c.amountMinor, line.currency)}
                      {c.inclusive ? ' (included)' : ''}
                    </div>
                  ))}
                </td>
                <td>{formatMoney(line.totalMinor, line.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Facts
        label="Quote totals"
        items={[
          ['Subtotal', formatMoney(quote.subtotalMinor, quote.currency)],
          ['Discounts', formatMoney(quote.discountMinor, quote.currency)],
          ['Taxes', formatMoney(quote.taxMinor, quote.currency)],
          ['Fees', formatMoney(quote.feeMinor, quote.currency)],
          ['Total', formatMoney(quote.totalMinor, quote.currency)],
          ['Credits applied', formatMoney(quote.creditsAppliedMinor, quote.currency)],
          ['Due now', formatMoney(quote.dueNowMinor, quote.currency)],
          [
            'Future obligations',
            quote.futureObligations.length === 0
              ? 'None'
              : quote.futureObligations
                  .map(
                    (o) =>
                      `${formatMoney(o.amountMinor, quote.currency)} due ${formatInstant(o.dueAt)}`,
                  )
                  .join('; '),
          ],
        ]}
      />
      <p className="caption">
        Policies: refund{' '}
        {quote.policies.refundPolicyVersionId
          ? shortRef(quote.policies.refundPolicyVersionId)
          : 'none'}
        , overpayment{' '}
        {quote.policies.overpaymentPolicyVersionId
          ? shortRef(quote.policies.overpaymentPolicyVersionId)
          : 'none'}
        .
        {quote.policies.defaults.length > 0
          ? ` Engineering defaults applied where no approved policy exists: ${quote.policies.defaults.map(humanize).join(', ')}.`
          : ''}
      </p>
    </div>
  );
}

function CheckoutResult({ checkout }: { checkout: Checkout }) {
  return (
    <section className="rf-panel" aria-labelledby="checkout-result-title" aria-live="polite">
      <h4 id="checkout-result-title">Checkout</h4>
      <p>
        <StatusBadge {...CHECKOUT_STATUS[checkout.status]} />
        {checkout.payment ? (
          <>
            {' '}
            <StatusBadge {...PAYMENT_STATUS[checkout.payment.status]} />
          </>
        ) : null}
      </p>
      {checkout.status === 'completed' ? (
        <>
          <p>
            Registered. The enrollments are linked to the household; if a participant was created by
            staff, issue a claim from <Link to="/people">People and families</Link> so the customer
            can claim it in the app.
          </p>
          <ul aria-label="Enrollments created">
            {checkout.enrollmentIds.map((id) => (
              <li key={id}>
                <Link to={`/registrations/enrollments/${id}`}>Enrollment {shortRef(id)}</Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {checkout.payment && checkout.payment.status === 'unknown' ? (
        <div data-testid="state-recovery">
          <StatusBadge tone="warning" label="Recovery required: payment outcome unknown" />
          <p>
            Do not take payment again. The attempt must be reconciled from provider evidence first
            (SPK-PAY-007).
          </p>
          <Link to={`/finance/payments/${checkout.payment.id}`}>
            Reconcile the payment attempt (SCR-S-36)
          </Link>
        </div>
      ) : null}
      {checkout.status === 'recovery_required' ? (
        <p>
          Money was received but the registration could not be completed. The finance operator queue
          owns it: <Link to={`/finance/checkouts/${checkout.id}`}>open the checkout recovery</Link>.
        </p>
      ) : null}
      {checkout.receipt ? (
        <p className="caption">
          Receipt {formatMoney(checkout.receipt.amountMinor, checkout.receipt.currency)}; allocated{' '}
          {formatMoney(checkout.receipt.allocatedMinor, checkout.receipt.currency)}; excess{' '}
          {formatMoney(checkout.receipt.excessMinor, checkout.receipt.currency)}.
        </p>
      ) : null}
      {checkout.nextAction ? (
        <p className="caption">Next action: {humanize(checkout.nextAction)}</p>
      ) : null}
    </section>
  );
}

function CheckoutById({ checkoutId }: { checkoutId: string }) {
  const checkout = useApiQuery({
    path: '/registration-checkouts/{id}',
    request: { path: { id: checkoutId } },
  });
  return (
    <QueryBoundary query={checkout} label="the checkout" empty={{ title: '', description: '' }}>
      {(data) => <CheckoutResult checkout={data} />}
    </QueryBoundary>
  );
}

/**
 * FIN-04, ENR-06 (SPK-UX-001): the checkout a basket started, from the basket's own references:
 * the checkout operation's state and outcome, the checkout it names once known, and the order's
 * payment attempts. Nothing here retries a payment.
 */
function CheckoutTrace({ basket }: { basket: Basket }) {
  const orderId = basket.orderRef && UUID.test(basket.orderRef) ? basket.orderRef : null;
  const operation = useOperation(basket.lastOperationId);
  const op = operation.data;
  const result =
    op?.result && typeof op.result === 'object' ? (op.result as Record<string, unknown>) : null;
  const checkoutId = typeof result?.['checkoutId'] === 'string' ? result['checkoutId'] : null;
  return (
    <section className="rf-panel" aria-labelledby="checkout-trace-title">
      <h4 id="checkout-trace-title">Checkout of this basket</h4>
      <Facts
        label="Checkout references"
        items={[
          [
            'Order',
            orderId ? (
              <Link key="order" to={`/finance/orders/${orderId}`}>
                Order {shortRef(orderId)}
              </Link>
            ) : (
              'No order yet'
            ),
          ],
          [
            'Checkout operation',
            basket.lastOperationId ? (
              op ? (
                <StatusBadge key="op" {...OPERATION_STATUS[op.status]} />
              ) : operation.error ? (
                `Not available (${operation.error.code})`
              ) : (
                'Loading…'
              )
            ) : (
              'Not recorded'
            ),
          ],
        ]}
      />
      {op && (op.status === 'pending' || op.status === 'running') ? (
        <p role="status">
          The checkout is still running; this updates when it finishes. Do not take payment again.
        </p>
      ) : null}
      {op?.error ? (
        <p>
          {op.status === 'recovery_required'
            ? 'Recovery required: money was received but the registration could not be completed. The finance operator queue owns it.'
            : 'The checkout did not complete.'}{' '}
          <span className="caption">
            {op.error.code}: {op.error.message}
          </span>
        </p>
      ) : null}
      {checkoutId ? <CheckoutById checkoutId={checkoutId} /> : null}
      {orderId ? (
        <PaymentAttemptList
          filter={{ orderId }}
          label="Payment attempts of the order"
          showPayer={false}
        />
      ) : null}
    </section>
  );
}

function PriceAndPay({ basket }: { basket: Basket }) {
  const online = useOnline();
  const { facilities } = useFacilities();
  const [codes, setCodes] = useState('');
  const [method, setMethod] = useState<'cash' | 'provider' | ''>('');
  const [tenderKind, setTenderKind] = useState<Schema<'CashTenderKind'>>('cash');
  const [facilityId, setFacilityId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const quote = useApiCommand('post', '/registration-quotes');
  const checkout = useApiCommand('post', '/registration-checkouts', { invalidate: [BASKET_KEY] });
  const current = quote.data ?? null;
  const same = useSameRequest(checkout.submit);
  // SPK-PAY-007: after no answer or PAYMENT_OUTCOME_UNKNOWN the payment may have been taken. No
  // new price or payment is offered until the attempt is reconciled; only the same request may be
  // retried, and the intent is never reset from here.
  const unresolved = outcomePending(checkout.error);

  const requestQuote = () => {
    if (unresolved) return;
    checkout.reset();
    same.forget();
    const discountCodes = codes
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    quote
      .submit({
        body: { basketId: basket.id, discountCodes, creditIds: [], paymentPlan: { kind: 'full' } },
      })
      .catch(() => undefined);
  };
  const requote = () => {
    if (unresolved) return;
    quote.reset();
    checkout.reset();
    same.forget();
    requestQuote();
  };
  const pay = () => {
    if (!current) return;
    const errors: Record<string, string> = {};
    const owes = current.dueNowMinor > 0;
    if (owes && method !== 'cash') errors.method = 'Choose how the payment is taken.';
    if (owes && method === 'cash') {
      if (!facilityId.trim()) errors.facilityId = 'Choose the facility where it was received.';
      if (!reference.trim()) errors.reference = 'Enter the receipt or slip reference.';
    }
    setLocal(errors);
    if (Object.keys(errors).length > 0) return;
    same
      .send({
        body: {
          quoteId: current.id,
          authorizeFutureInstallments: false,
          ...(owes
            ? {
                payment: {
                  method: 'cash' as const,
                  tenderKind,
                  facilityId: facilityId.trim(),
                  evidence: {
                    reference: reference.trim(),
                    ...(notes.trim() ? { notes: notes.trim() } : {}),
                  },
                },
              }
            : {}),
        },
      })
      .catch(() => undefined);
  };

  return (
    <section className="rf-panel" aria-labelledby="price-pay-title">
      <h3 id="price-pay-title">Price and payment</h3>
      {basket.approvalPending ? (
        <p>
          A line needs approval before payment is captured (SPK-REG-007). It is in the{' '}
          <Link to="/registrations/queue">approval queue</Link>.
        </p>
      ) : null}
      {basket.status === 'held' && !checkout.data && !unresolved ? (
        <>
          <TextField label="Discount codes (comma separated)" value={codes} onChange={setCodes} />
          <div className="rf-actions">
            <Button busy={quote.isProcessing} disabled={!online} onClick={requestQuote}>
              {current ? 'Price again' : 'Price the basket'}
            </Button>
          </div>
          <p className="caption">
            Prices come from the server&apos;s price rules, never from this screen (SPK-PAY-001).
            Installment plans are pending {PENDING.installments.ids.join(', ')} (owner:{' '}
            {PENDING.installments.owner}).
          </p>
        </>
      ) : null}
      {basket.status === 'checking_out' && !checkout.data && !checkout.error ? (
        // SPK-PAY-007 recovery: a checkout in flight (for example after a reload) is never a
        // reason to take payment again.
        <section className="state" data-testid="checkout-in-progress" aria-live="polite">
          <StatusBadge tone="warning" label="Checkout in progress: do not take payment again" />
          <p>
            A checkout for this basket is in progress or its payment outcome is being confirmed.
            Check the payment before doing anything else.
          </p>
          <Link to="/finance/payments">Open unknown payment outcomes</Link>
        </section>
      ) : basket.status !== 'held' && !checkout.data ? (
        <p>
          This basket is {BASKET_STATUS[basket.status].label}. Each line links to its enrollment
          once one exists.
        </p>
      ) : null}
      {basket.status !== 'held' && !checkout.data && basket.orderRef ? (
        // The checkout sets the order reference and its operation together (FIN-04).
        <CheckoutTrace basket={basket} />
      ) : null}
      <CommandError error={quote.error} onRequote={requote} />
      {current && !unresolved ? <QuoteView quote={current} /> : null}
      {current && !checkout.data && basket.status === 'held' && !unresolved ? (
        <form
          noValidate
          aria-label="Take payment"
          onSubmit={(event) => {
            event.preventDefault();
            pay();
          }}
        >
          {current.dueNowMinor > 0 ? (
            <>
              <SelectField
                label="Payment method"
                required
                value={method}
                placeholder="Choose a method"
                onChange={(v) => setMethod(v as 'cash' | 'provider' | '')}
                options={[
                  { value: 'cash', label: 'Cash or external tender with evidence' },
                  { value: 'provider', label: 'Card through the payment provider' },
                ]}
                error={local.method}
              />
              {method === 'provider' ? (
                <StateView
                  variant="pending-decision"
                  subject="Card payment at the desk"
                  decisions={PENDING.paymentProvider.ids}
                  owner={PENDING.paymentProvider.owner}
                />
              ) : null}
              {method === 'cash' ? (
                <>
                  <div className="rf-grid">
                    <SelectField
                      label="Tender"
                      value={tenderKind}
                      onChange={(v) => setTenderKind(v as Schema<'CashTenderKind'>)}
                      options={Object.entries(TENDER_KIND).map(([value, label]) => ({
                        value,
                        label,
                      }))}
                    />
                    {facilities.length > 0 ? (
                      <SelectField
                        label="Facility"
                        required
                        value={facilityId}
                        placeholder="Choose a facility"
                        onChange={setFacilityId}
                        options={facilities.map((f) => ({ value: f.id, label: f.name }))}
                        error={local.facilityId}
                      />
                    ) : (
                      <TextField
                        label="Facility reference"
                        required
                        value={facilityId}
                        onChange={setFacilityId}
                        error={local.facilityId}
                      />
                    )}
                    <TextField
                      label="Evidence reference"
                      required
                      hint="Receipt, slip or terminal reference."
                      value={reference}
                      onChange={setReference}
                      error={local.reference}
                    />
                  </div>
                  <TextArea label="Evidence notes" value={notes} onChange={setNotes} />
                  <StateView
                    variant="pending-decision"
                    subject="The approved cash and external tender procedure"
                    decisions={PENDING.refundsCreditsCash.ids.slice(0, 1)}
                    owner={PENDING.refundsCreditsCash.owner}
                  />
                  <p className="caption">
                    Recording a tender never bypasses eligibility, approval or capacity checks
                    (SPK-PAY-012); the API checks your tender permissions.
                  </p>
                </>
              ) : null}
            </>
          ) : (
            <p>Nothing is due now. Completing the checkout confirms the registration.</p>
          )}
          <div className="rf-actions">
            <Button
              type="submit"
              busy={checkout.isProcessing}
              disabled={!online || (current.dueNowMinor > 0 && method !== 'cash')}
            >
              {current.dueNowMinor > 0 ? 'Record payment and check out' : 'Complete registration'}
            </Button>
          </div>
          <OfflineCaption action="checking out" />
          {checkout.isProcessing ? <p role="status">Processing the checkout…</p> : null}
        </form>
      ) : null}
      <CommandError
        error={checkout.error}
        onRequote={unresolved ? undefined : requote}
        currency={current?.currency}
        onRetry={same.retry}
      />
      {checkout.data ? <CheckoutResult checkout={checkout.data} /> : null}
    </section>
  );
}

function BasketView({ basket }: { basket: Basket }) {
  const online = useOnline();
  const now = useNow();
  const queryClient = useQueryClient();
  const [releaseReason, setReleaseReason] = useState('');
  const hold = useApiCommand('post', '/baskets/{id}/hold', { invalidate: [BASKET_KEY] });
  const release = useApiCommand('post', '/baskets/{id}/release', { invalidate: [BASKET_KEY] });
  const reloadAfterRelease = useBasketReload(release.reset);
  const reload = () => {
    hold.reset();
    void queryClient.invalidateQueries({ queryKey: BASKET_KEY });
  };
  const live = basket.status === 'open' || basket.status === 'held';
  return (
    <>
      <p>
        <StatusBadge {...BASKET_STATUS[basket.status]} />
      </p>
      <Facts
        label="Basket"
        items={[
          ['Household adult', <PersonName key="owner" id={basket.ownerPersonId} />],
          ['Payer', <PersonName key="payer" id={basket.payerPersonId ?? basket.ownerPersonId} />],
          ['Recorded by', `${basket.createdBy.actorLabel} (${basket.createdBy.kind})`],
          [
            'Fulfillment',
            basket.fulfillmentMode === 'all_or_nothing'
              ? 'All or nothing'
              : 'Partial (customer accepted)',
          ],
          ['Subtotal of base prices', formatMoney(basket.subtotalMinor, basket.currency)],
          [
            'Hold expires',
            basket.holdExpiresAt
              ? `${formatInstant(basket.holdExpiresAt)} (server-owned; any countdown is informational)`
              : 'No hold',
          ],
        ]}
      />
      <section className="rf-panel" aria-labelledby="lines-title">
        <h3 id="lines-title">Participants and offerings</h3>
        {basket.lines.length === 0 ? (
          <p>No lines yet. Add each participant with the offering they register for.</p>
        ) : (
          <ul className="list" aria-label="Basket lines">
            {basket.lines.map((line) => (
              <LineItem key={line.id} basket={basket} line={line} />
            ))}
          </ul>
        )}
        {basket.status === 'open' ? <AddLine basket={basket} /> : null}
      </section>
      {basket.holds.length > 0 ? (
        <section className="rf-panel" aria-labelledby="holds-title">
          <h3 id="holds-title">Capacity holds</h3>
          <ul className="list" aria-label="Capacity holds">
            {basket.holds.map((h) => (
              <li key={h.id}>
                <div className="row-text">
                  <StatusBadge {...HOLD_STATUS[h.status]} />
                  <span className="caption">
                    Pool {shortRef(h.poolId)} · quantity {h.quantity} · expires{' '}
                    {formatInstant(h.expiresAt)}
                    {h.status === 'active' && new Date(h.expiresAt) <= now
                      ? ' (expiry reached; the server decides)'
                      : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {basket.status === 'open' && basket.lines.length > 0 ? (
        <div className="rf-actions">
          <Button
            busy={hold.isProcessing}
            disabled={!online}
            onClick={() =>
              hold
                .submit({ path: { id: basket.id }, body: { expectedRevision: basket.revision } })
                .catch(() => undefined)
            }
          >
            Hold the places
          </Button>
        </div>
      ) : null}
      <CommandError error={hold.error} onReload={reload} />
      {PRICED_STATUSES.includes(basket.status) ? <PriceAndPay basket={basket} /> : null}
      {live ? (
        <details className="rf-panel">
          <summary>Release the basket</summary>
          <form
            noValidate
            aria-label="Release the basket"
            onSubmit={(event) => {
              event.preventDefault();
              if (!releaseReason.trim()) return;
              release
                .submit({
                  path: { id: basket.id },
                  body: { reason: releaseReason.trim(), expectedRevision: basket.revision },
                })
                .catch(() => undefined);
            }}
          >
            <TextArea
              label="Reason for releasing"
              required
              value={releaseReason}
              onChange={setReleaseReason}
            />
            <Button
              type="submit"
              variant="secondary"
              busy={release.isProcessing}
              disabled={!online || !releaseReason.trim()}
            >
              Release the basket and its holds
            </Button>
            <CommandError error={release.error} onReload={reloadAfterRelease} />
          </form>
        </details>
      ) : null}
      <OfflineCaption action="changing the basket" />
    </>
  );
}

export function AssistedRegistrationScreen() {
  const { basketId } = useParams();
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: basketId ?? '' } },
    enabled: basketId !== undefined,
  });
  if (basketId === undefined) {
    return (
      <section aria-labelledby="assisted-title">
        <h2 id="assisted-title">Assisted registration</h2>
        <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
        <StartBasket />
      </section>
    );
  }
  return (
    <section aria-labelledby="assisted-title">
      {/* SPK-UX-009: the region keeps its name and the area navigation in every state. */}
      <h2 id="assisted-title">Assisted registration</h2>
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <QueryBoundary
        query={basket}
        label="the basket"
        empty={{ title: '', description: '' }}
        unavailableOffline={['adding lines', 'holding places', 'pricing', 'checking out']}
      >
        {(data) => <BasketView basket={data} />}
      </QueryBoundary>
    </section>
  );
}
