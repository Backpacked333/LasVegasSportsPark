/**
 * SCR-S-37 Refunds and credits: credits (SPK-PAY-009, SPK-PAY-008, DEC-009, DEC-058). Each credit
 * shows its owner, currency, permitted uses, expiry, original and remaining balance, source,
 * status and redemption history (redemptions and reversals). Finance may approve a credit held
 * pending approval (an overpayment, POL-015), redeem one against an obligation (the API prevents
 * redeeming the same credit twice), and issue a goodwill or adjustment credit with a reason.
 * Every command carries an idempotency key per intent. Expiry and permitted uses are what finance
 * enters: the policy is pending DEC-058, so nothing is preset.
 *
 * Credits are listed per owner (`GET /v1/credits?ownerPersonId=`); `/finance/credits/{id}` opens
 * one credit. Refunds are requested from a succeeded payment attempt (see the payment screen).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import {
  CheckboxGroup,
  Facts,
  SelectField,
  TextArea,
  TextField,
} from '../../features/registration-finance/fields';
import {
  dateToInstant,
  formatInstant,
  formatMoney,
  humanize,
  parseMoneyInput,
} from '../../features/registration-finance/format';
import { CREDIT_STATUS } from '../../features/registration-finance/labels';
import { PersonName } from '../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Credit = Schema<'Credit'>;
type CreditUse = Schema<'CreditUse'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDIT_INVALIDATE = [
  ['api', '/credits'],
  ['api', '/credits/{id}'],
] as const;
const USES: readonly { value: CreditUse; label: string }[] = [
  { value: 'registration', label: 'Registration' },
  { value: 'obligation', label: 'Obligations' },
];

function CreditActions({ credit }: { credit: Credit }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const approve = useApiCommand('post', '/credits/{id}/approve', { invalidate: CREDIT_INVALIDATE });
  const redeem = useApiCommand('post', '/credits/{id}/redeem', { invalidate: CREDIT_INVALIDATE });
  const [obligationId, setObligationId] = useState('');
  const [amount, setAmount] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const reload = () => {
    approve.reset();
    redeem.reset();
    void queryClient.invalidateQueries({ queryKey: ['api', '/credits'] });
    void queryClient.invalidateQueries({ queryKey: ['api', '/credits/{id}'] });
  };
  return (
    <>
      {credit.status === 'pending_approval' ? (
        <div className="rf-actions">
          <Button
            busy={approve.isProcessing}
            disabled={!online}
            aria-label={`Approve the credit of ${formatMoney(credit.originalMinor, credit.currency)}`}
            onClick={() =>
              approve
                .submit({ path: { id: credit.id }, body: { expectedRevision: credit.revision } })
                .catch(() => undefined)
            }
          >
            Approve
          </Button>
        </div>
      ) : null}
      {credit.status === 'active' && credit.permittedUses.includes('obligation') ? (
        <form
          noValidate
          aria-label="Redeem against an obligation"
          onSubmit={(event) => {
            event.preventDefault();
            const errors: Record<string, string> = {};
            if (!UUID.test(obligationId.trim()))
              errors.obligationId = 'Enter the obligation reference.';
            const minor = parseMoneyInput(amount, credit.currency);
            if (minor === null)
              errors.amountMinor = `Enter a positive amount in ${credit.currency}.`;
            setLocal(errors);
            if (minor === null || Object.keys(errors).length > 0) return;
            redeem
              .submit({
                path: { id: credit.id },
                body: {
                  obligationId: obligationId.trim(),
                  amountMinor: minor,
                  expectedRevision: credit.revision,
                },
              })
              .catch(() => undefined);
          }}
        >
          <div className="rf-grid">
            <TextField
              label="Obligation reference"
              value={obligationId}
              onChange={setObligationId}
              error={local.obligationId}
            />
            <TextField
              label={`Amount to redeem (${credit.currency})`}
              inputMode="decimal"
              value={amount}
              onChange={setAmount}
              error={local.amountMinor}
            />
          </div>
          <Button type="submit" variant="secondary" busy={redeem.isProcessing} disabled={!online}>
            Redeem
          </Button>
        </form>
      ) : null}
      <CommandError
        error={approve.error ?? redeem.error}
        onReload={reload}
        currency={credit.currency}
      />
    </>
  );
}

function CreditCard({ credit }: { credit: Credit }) {
  return (
    <li aria-labelledby={`credit-${credit.id}`}>
      <div className="row-text">
        <span className="row-title" id={`credit-${credit.id}`}>
          <Link to={`/finance/credits/${credit.id}`}>
            Credit {formatMoney(credit.remainingMinor, credit.currency)} remaining of{' '}
            {formatMoney(credit.originalMinor, credit.currency)}
          </Link>
        </span>
        <StatusBadge {...CREDIT_STATUS[credit.status]} />
        <Facts
          label="Credit"
          items={[
            ['Owner', <PersonName key="owner" id={credit.ownerPersonId} fallback="Owner" />],
            ['Currency', credit.currency],
            ['Permitted uses', credit.permittedUses.map(humanize).join(', ')],
            ['Expiry', credit.expiresAt ? formatInstant(credit.expiresAt) : 'No expiry'],
            [
              'Source',
              `${humanize(credit.sourceKind)}${credit.sourceId ? ` (${credit.sourceId.slice(0, 8)})` : ''}`,
            ],
            ['Reason', credit.reason],
            ['Approved', formatInstant(credit.approvedAt)],
          ]}
        />
        {credit.redemptions.length > 0 ? (
          <ul aria-label="Redemption history">
            {credit.redemptions.map((r) => (
              <li key={r.id}>
                {r.kind === 'redeem' ? 'Redeemed' : 'Reversal'}{' '}
                {formatMoney(r.amountMinor, credit.currency)} on {formatInstant(r.redeemedAt)} (
                {humanize(r.referenceType)})
              </li>
            ))}
          </ul>
        ) : (
          <span className="caption">No redemptions.</span>
        )}
        <CreditActions credit={credit} />
      </div>
    </li>
  );
}

function IssueCredit({ ownerId }: { ownerId: string }) {
  const online = useOnline();
  const [owner, setOwner] = useState(ownerId);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [uses, setUses] = useState<string[]>([]);
  const [expires, setExpires] = useState('');
  const [sourceKind, setSourceKind] = useState<'goodwill' | 'adjustment' | ''>('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const issue = useApiCommand('post', '/credits', { invalidate: CREDIT_INVALIDATE });
  const server = fieldErrorsOf(issue.error);
  return (
    <details className="rf-panel">
      <summary>Issue a credit</summary>
      <p className="caption">
        Credit expiry and permitted uses are pending {PENDING.refundsCreditsCash.ids.join(', ')}{' '}
        (owner: {PENDING.refundsCreditsCash.owner}); enter what finance approved.
      </p>
      <form
        noValidate
        aria-label="Issue a credit"
        onSubmit={(event) => {
          event.preventDefault();
          const errors: Record<string, string> = {};
          const code = currency.trim().toUpperCase();
          if (!UUID.test(owner.trim()))
            errors.ownerPersonId = 'Enter the owner’s person reference.';
          if (!/^[A-Z]{3}$/.test(code)) errors.currency = 'Enter a three-letter currency code.';
          const minor = /^[A-Z]{3}$/.test(code) ? parseMoneyInput(amount, code) : null;
          if (minor === null) errors.amountMinor = 'Enter a positive amount.';
          if (uses.length === 0) errors.permittedUses = 'Choose at least one permitted use.';
          if (!sourceKind) errors.sourceKind = 'Choose the source.';
          const expiresAt = expires ? dateToInstant(expires, true) : null;
          if (expires && !expiresAt) errors.expiresAt = 'Enter a date or leave empty.';
          if (!reason.trim()) errors.reason = 'A reason is required and is audited.';
          setLocal(errors);
          if (minor === null || !sourceKind || Object.keys(errors).length > 0) return;
          issue
            .submit({
              body: {
                ownerPersonId: owner.trim(),
                amountMinor: minor,
                currency: code,
                permittedUses: uses as CreditUse[],
                sourceKind,
                reason: reason.trim(),
                ...(expiresAt ? { expiresAt } : {}),
              },
            })
            .then(() => setAmount(''))
            .catch(() => undefined);
        }}
      >
        <div className="rf-grid">
          <TextField
            label="Owner reference"
            required
            value={owner}
            onChange={setOwner}
            error={local.ownerPersonId ?? server.ownerPersonId}
          />
          <TextField
            label="Credit amount"
            inputMode="decimal"
            required
            value={amount}
            onChange={setAmount}
            error={local.amountMinor ?? server.amountMinor}
          />
          <TextField
            label="Credit currency"
            required
            value={currency}
            onChange={setCurrency}
            error={local.currency ?? server.currency}
          />
          <TextField
            label="Expires at the end of (UTC date)"
            type="date"
            hint="Leave empty for no expiry."
            value={expires}
            onChange={setExpires}
            error={local.expiresAt ?? server.expiresAt}
          />
          <SelectField
            label="Source"
            required
            value={sourceKind}
            placeholder="Choose a source"
            onChange={(v) => setSourceKind(v as 'goodwill' | 'adjustment' | '')}
            options={[
              { value: 'goodwill', label: 'Goodwill' },
              { value: 'adjustment', label: 'Adjustment' },
            ]}
            error={local.sourceKind}
          />
        </div>
        <CheckboxGroup legend="Permitted uses" options={USES} values={uses} onChange={setUses} />
        {local.permittedUses ? <p className="rf-error">{local.permittedUses}</p> : null}
        <TextArea
          label="Reason for the credit"
          required
          value={reason}
          onChange={setReason}
          error={local.reason ?? server.reason}
        />
        <div className="rf-actions">
          <Button type="submit" busy={issue.isProcessing} disabled={!online}>
            Issue the credit
          </Button>
        </div>
        <OfflineCaption action="issuing a credit" />
        {issue.data ? (
          <p role="status">
            Credit issued: {formatMoney(issue.data.originalMinor, issue.data.currency)},{' '}
            {CREDIT_STATUS[issue.data.status].label}.
          </p>
        ) : null}
        <CommandError error={issue.error} />
      </form>
    </details>
  );
}

function OwnerCredits({ ownerId }: { ownerId: string }) {
  const credits = useApiQuery({
    path: '/credits',
    request: { query: { ownerPersonId: ownerId, limit: 200 } },
  });
  return (
    <QueryBoundary
      query={credits}
      label="credits"
      isEmpty={(page) => page.items.length === 0}
      empty={{ title: 'No credits', description: 'This person holds no credits.' }}
      unavailableOffline={['approving or redeeming credits']}
    >
      {(page) => (
        <ul className="list" aria-label="Credits">
          {page.items.map((credit) => (
            <CreditCard key={credit.id} credit={credit} />
          ))}
        </ul>
      )}
    </QueryBoundary>
  );
}

function OneCredit({ creditId }: { creditId: string }) {
  const credit = useApiQuery({ path: '/credits/{id}', request: { path: { id: creditId } } });
  return (
    <QueryBoundary
      query={credit}
      label="the credit"
      empty={{ title: '', description: '' }}
      unavailableOffline={['approving or redeeming']}
    >
      {(data) => (
        <ul className="list" aria-label="Credits">
          <CreditCard credit={data} />
        </ul>
      )}
    </QueryBoundary>
  );
}

export function CreditsScreen() {
  const { creditId } = useParams();
  const [owner, setOwner] = useState('');
  const ownerId = UUID.test(owner.trim()) ? owner.trim() : '';
  return (
    <section aria-labelledby="credits-title">
      <h2 id="credits-title">Refunds and credits</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <p>
        Refunds start from a succeeded payment attempt: open it from{' '}
        <Link to="/finance/payments">Payment attempts</Link>. Credits are below.
      </p>
      {creditId ? (
        <OneCredit creditId={creditId} />
      ) : (
        <>
          <TextField
            label="Credit owner reference"
            hint="The person reference whose credits to show."
            value={owner}
            onChange={setOwner}
          />
          {ownerId ? (
            <OwnerCredits ownerId={ownerId} />
          ) : (
            <StateView
              variant="empty"
              title="Choose a credit owner"
              description="Enter a person reference to list their credits with balances and history."
            />
          )}
          <IssueCredit ownerId={ownerId} />
        </>
      )}
    </section>
  );
}
