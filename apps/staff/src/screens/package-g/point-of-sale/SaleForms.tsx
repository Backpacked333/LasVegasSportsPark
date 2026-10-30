/**
 * SCR-S-55 sale commands (§3.16 POS; SPK-PAY-001, SPK-PAY-002, SPK-PAY-007, SPK-PAY-008,
 * SPK-PAY-012; §4.9 one idempotency key per intent):
 *
 * - AddLineForm: a product and a quantity (`POST /v1/pos-sales/{id}/lines`). No price is sent: the
 *   product's price and the approved taxes and fees in effect apply (CHARGE_POLICY_NOT_APPROVED is
 *   shown as a validation failure naming the tax or fee).
 * - TenderForm: cash, an external tender with its evidence, or a card
 *   (`POST /v1/pos-sales/{id}/tenders`). The card processor is pending (DEC-019): release builds
 *   offer no card tender and say so; development builds pick a fake provider scenario. A card
 *   payment's answer is shown as the API records it: succeeded pays, failed takes nothing, and
 *   unknown or processing leave the sale open and are never shown as paid (SPK-PAY-007).
 * - ReturnForm: units of paid lines, the tender kind to refund by and the reason
 *   (`POST /v1/pos-sales/{id}/returns`, finance.approve_pos_return, never gated). The API computes
 *   the amount and refuses more than was paid that way (RETURN_EXCEEDS_TENDER with what is still
 *   refundable); a card refund whose outcome is not final keeps its reservation (SPK-PAY-008).
 *
 * While a command's outcome is unknown the form is locked and "Try again" resends the same request
 * with the same key, so no tender or return is recorded twice.
 */
import type { Schema } from '@sportspark/api-client';
import { Suspense, useMemo, useState, type FormEvent } from 'react';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { DevCardMethodPicker } from '../../../features/pos-access-accounting/dev';
import { MoneyField } from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import {
  CARD_PAYMENT_STATUS,
  POS_TENDER_KIND,
} from '../../../features/pos-access-accounting/labels';
import { formatMoney, parseMoneyInput } from '../../../features/registration-finance/format';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { Button } from '../../../ui/Button';
import { RadioGroup, SelectField, TextField } from '../../../ui/FormFields';
import { isUuid } from '../../../ui/RecordRef';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { SALE_QUERY_PREFIX } from './paths';

type Sale = Schema<'PosSale'>;
type TenderKind = Schema<'PosTenderKind'>;

const SALE_COMMAND = { invalidate: [SALE_QUERY_PREFIX] } as const;

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

export function AddLineForm({ sale }: { sale: Sale }) {
  const online = useOnline();
  const products = useApiPages({
    path: '/pos-products',
    request: { query: { facilityId: sale.facilityId, status: 'active', limit: 100 } },
  });
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-sales/{id}/lines', SALE_COMMAND);
  const intent = useIntentForm(command);
  // Only products the API could add: active, sold here, priced in the sale's currency.
  const options = useMemo(
    () =>
      (products.data ?? [])
        .filter((p) => p.currency === sale.currency)
        .map((p) => ({
          value: p.id,
          label: `${p.name} (${p.sku}) · ${formatMoney(p.priceMinor, p.currency)}`,
        })),
    [products.data, sale.currency],
  );
  const qty = /^\d{1,3}$/.test(quantity.trim()) ? Number(quantity.trim()) : 0;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!productId || qty < 1) return;
    const updated = await intent.send({
      path: { id: sale.id },
      body: { productId, quantity: qty },
    });
    if (updated) {
      setProductId('');
      setQuantity('1');
      setTouched(false);
    }
  };
  return (
    <form className="rf-panel" aria-label="Add a line" onSubmit={(e) => void submit(e)} noValidate>
      <h4>Add a line</h4>
      <p className="caption">
        The product&apos;s price and its approved taxes and fees apply; no price is typed here
        (SPK-PAY-001, DEC-057).
      </p>
      {products.data === undefined && products.error ? (
        <StateView variant="error" error={products.error} onRetry={() => void products.refetch()} />
      ) : (
        <SelectField
          label="Product"
          required
          value={productId}
          onChange={setProductId}
          options={options}
          placeholder={
            products.data === undefined
              ? 'Loading products…'
              : options.length === 0
                ? 'No active product is sold here in this currency'
                : 'Choose a product'
          }
          error={touched && !productId ? 'Choose a product.' : null}
          disabled={intent.locked}
        />
      )}
      <TextField
        label="Quantity"
        required
        hint="1 to 999."
        value={quantity}
        onChange={setQuantity}
        error={touched && qty < 1 ? 'Enter a quantity from 1 to 999.' : null}
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Add to the sale
      </Button>
      <OfflineCaption action="adding a line" />
      <CommandError error={command.error} onRetry={intent.retry} currency={sale.currency} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Tenders
// ---------------------------------------------------------------------------------------------

/** The tender this command just recorded: the newest one on the answered sale. */
function newestTender(sale: Sale): Schema<'PosTender'> | null {
  return [...sale.tenders].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1)).at(-1) ?? null;
}

function TenderOutcome({ sale }: { sale: Sale }) {
  const tender = newestTender(sale);
  if (!tender) return null;
  if (tender.kind !== 'card') {
    return (
      <p role="status">
        {POS_TENDER_KIND[tender.kind]} tender of {formatMoney(tender.amountMinor, tender.currency)}{' '}
        recorded.{' '}
        {sale.status === 'paid'
          ? 'The sale is paid.'
          : `Remaining to pay: ${formatMoney(sale.remainingMinor, sale.currency)}.`}
      </p>
    );
  }
  const status = tender.paymentStatus ?? 'created';
  const text =
    status === 'succeeded'
      ? sale.status === 'paid'
        ? 'The card payment succeeded. The sale is paid.'
        : `The card payment succeeded. Remaining to pay: ${formatMoney(sale.remainingMinor, sale.currency)}.`
      : status === 'failed' || status === 'canceled'
        ? 'The card payment did not go through: nothing was taken. Take another tender.'
        : status === 'unknown'
          ? 'The card payment has no confirmed outcome: the sale stays open and is not paid. Reconcile it before taking another tender.'
          : 'The card payment is not final yet: the sale is not paid.';
  return (
    <p role="status">
      <StatusBadge {...CARD_PAYMENT_STATUS[status]} /> {text}
    </p>
  );
}

export function TenderForm({ sale }: { sale: Sale }) {
  const online = useOnline();
  const [kind, setKind] = useState<TenderKind | ''>('');
  const [amount, setAmount] = useState('');
  const [evidence, setEvidence] = useState('');
  const [notes, setNotes] = useState('');
  const [token, setToken] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-sales/{id}/tenders', SALE_COMMAND);
  const intent = useIntentForm(command);
  const c = sale.currency;
  const amountMinor = parseMoneyInput(amount, c);
  const cardAvailable = DevCardMethodPicker !== null;
  const options = [
    { value: 'cash', label: POS_TENDER_KIND.cash },
    { value: 'external', label: POS_TENDER_KIND.external },
    ...(cardAvailable ? [{ value: 'card', label: POS_TENDER_KIND.card }] : []),
  ];
  const cardNeedsCustomer = kind === 'card' && sale.customerPersonId === null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!kind || amountMinor === null) return;
    if (kind === 'external' && !evidence.trim()) return;
    if (kind === 'card' && (!token || cardNeedsCustomer)) return;
    const body =
      kind === 'cash'
        ? { kind, amountMinor }
        : kind === 'external'
          ? {
              kind,
              amountMinor,
              evidence: {
                reference: evidence.trim(),
                ...(notes.trim() ? { notes: notes.trim() } : {}),
              },
            }
          : { kind, amountMinor, paymentMethodToken: token };
    const updated = await intent.send({ path: { id: sale.id }, body });
    if (updated) {
      setAmount('');
      setEvidence('');
      setNotes('');
      setToken('');
      setTouched(false);
    }
  };
  const locked = intent.locked;
  return (
    <form
      className="rf-panel"
      aria-label="Take a tender"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Take a tender</h4>
      <p>Remaining to pay: {formatMoney(sale.remainingMinor, c)}.</p>
      <RadioGroup
        legend="Tender"
        name={`tender-${sale.id}`}
        required
        options={options}
        value={kind}
        onChange={(v) => setKind(v as TenderKind)}
        error={touched && !kind ? 'Choose how the customer pays.' : null}
        disabled={locked}
      />
      {!cardAvailable ? (
        <StateView
          variant="pending-decision"
          subject="Card tenders at the register"
          decisions={['DEC-019']}
          owner="Technical lead/account owners"
        />
      ) : null}
      <MoneyField
        label="Amount"
        currency={c}
        required
        value={amount}
        onChange={setAmount}
        hint={`At most ${formatMoney(sale.remainingMinor, c)}.`}
        error={touched && amountMinor === null ? `Enter a positive amount in ${c}.` : null}
        disabled={locked}
      />
      {kind === 'external' ? (
        <>
          <TextField
            label="Evidence reference"
            required
            hint="The terminal slip, cheque or transfer reference (SPK-PAY-012)."
            value={evidence}
            onChange={setEvidence}
            error={touched && !evidence.trim() ? 'Enter the evidence reference.' : null}
            disabled={locked}
          />
          <TextField label="Evidence notes" value={notes} onChange={setNotes} disabled={locked} />
        </>
      ) : null}
      {kind === 'card' && DevCardMethodPicker ? (
        <>
          {cardNeedsCustomer ? (
            <p className="error-text">
              A card tender needs the sale to name its customer (the payer of the card payment).
              Start a new sale with the customer to take a card.
            </p>
          ) : null}
          <Suspense fallback={<p className="caption">Loading the development card methods…</p>}>
            <DevCardMethodPicker value={token} onChange={setToken} disabled={locked} />
          </Suspense>
          {touched && !token ? <p className="error-text">Choose a card method.</p> : null}
        </>
      ) : null}
      <Button
        type="submit"
        busy={command.isProcessing}
        disabled={!online || locked || cardNeedsCustomer}
      >
        Record the tender
      </Button>
      {command.data && !command.error ? <TenderOutcome sale={command.data} /> : null}
      <OfflineCaption action="taking a tender" />
      <CommandError error={command.error} onRetry={intent.retry} currency={c} />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------------------------

export function ReturnForm({ sale, onReload }: { sale: Sale; onReload: () => void }) {
  const online = useOnline();
  const [units, setUnits] = useState<Record<string, string>>({});
  const [kind, setKind] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [drawer, setDrawer] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/pos-sales/{id}/returns', SALE_COMMAND);
  const intent = useIntentForm(command);
  const lines = sale.lines.filter((l) => l.quantity - l.returnedQuantity > 0);
  // Refunds go back the way the sale was paid: the kinds of its settled tenders.
  const kinds = [...new Set(sale.tenders.filter((t) => t.status === 'settled').map((t) => t.kind))];
  const requested = lines.flatMap((l) => {
    const text = (units[l.id] ?? '').trim();
    if (!text) return [];
    const n = /^\d{1,3}$/.test(text) ? Number(text) : -1;
    return [{ line: l, quantity: n }];
  });
  const invalid = requested.filter(
    (r) => r.quantity < 1 || r.quantity > r.line.quantity - r.line.returnedQuantity,
  );
  const drawerError =
    drawer.trim() && !isUuid(drawer) ? 'Enter a register session reference.' : null;
  if (lines.length === 0) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (requested.length === 0 || invalid.length > 0 || !kind || !reason.trim()) return;
    if (kind === 'external' && !evidence.trim()) return;
    if (drawerError) return;
    const updated = await intent.send({
      path: { id: sale.id },
      body: {
        lines: requested.map((r) => ({ saleLineId: r.line.id, quantity: r.quantity })),
        tenderKind: kind as TenderKind,
        reason: reason.trim(),
        ...(kind === 'external' ? { evidence: { reference: evidence.trim() } } : {}),
        ...(kind === 'cash' && drawer.trim() ? { registerSessionId: drawer.trim() } : {}),
      },
    });
    if (updated) {
      setUnits({});
      setReason('');
      setEvidence('');
      setDrawer('');
      setTouched(false);
    }
  };
  const locked = intent.locked;
  const latest = command.data?.returns.at(-1);
  return (
    <form
      className="rf-panel"
      aria-label="Return lines"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Return lines</h4>
      <p className="caption">
        The API computes the refund for the units returned, with their share of taxes and fees, and
        refuses more than was paid by the chosen tender.
      </p>
      {lines.map((l) => {
        const left = l.quantity - l.returnedQuantity;
        const bad = invalid.some((r) => r.line.id === l.id);
        return (
          <TextField
            key={l.id}
            label={`Units of ${l.name} to return`}
            hint={`Up to ${left} of ${l.quantity} sold (${formatMoney(l.lineTotalMinor, sale.currency)} for the line).`}
            value={units[l.id] ?? ''}
            onChange={(v) => setUnits((u) => ({ ...u, [l.id]: v }))}
            error={touched && bad ? `Enter 1 to ${left}, or leave it empty.` : null}
            disabled={locked}
          />
        );
      })}
      {touched && requested.length === 0 ? (
        <p className="error-text">Enter the units to return on at least one line.</p>
      ) : null}
      <SelectField
        label="Refund by"
        required
        value={kind}
        onChange={setKind}
        options={kinds.map((k) => ({ value: k, label: POS_TENDER_KIND[k] }))}
        placeholder="Choose how the refund is paid"
        error={touched && !kind ? 'Choose how the refund is paid.' : null}
        disabled={locked}
      />
      {kind === 'external' ? (
        <TextField
          label="Evidence reference"
          required
          value={evidence}
          onChange={setEvidence}
          error={touched && !evidence.trim() ? 'Enter the evidence reference.' : null}
          disabled={locked}
        />
      ) : null}
      {kind === 'cash' ? (
        <TextField
          label="Register session paying the cash (reference)"
          hint="Leave empty to pay from the sale's own session while it is open."
          value={drawer}
          onChange={setDrawer}
          error={touched ? drawerError : null}
          disabled={locked}
        />
      ) : null}
      <TextField
        label="Reason for the return"
        required
        value={reason}
        onChange={setReason}
        error={touched && !reason.trim() ? 'Enter a reason.' : null}
        disabled={locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || locked}>
        Approve and record the return
      </Button>
      {latest && !command.error ? (
        <p role="status">
          Return of {formatMoney(latest.amountMinor, sale.currency)} recorded
          {latest.refundStatus && latest.refundStatus !== 'succeeded'
            ? `; the card refund is ${latest.refundStatus} and its amount stays reserved until the provider confirms.`
            : '.'}
        </p>
      ) : null}
      <OfflineCaption action="recording a return" />
      <CommandError
        error={command.error}
        onRetry={intent.retry}
        onReload={() => {
          intent.restart();
          onReload();
        }}
        currency={sale.currency}
      />
    </form>
  );
}
