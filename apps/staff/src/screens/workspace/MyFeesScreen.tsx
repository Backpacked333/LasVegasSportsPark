/**
 * SCR-W-08 Hours and fee records (SPK-STAFF-006, §1.7, DEC-011, DEC-052): the viewer's own fee
 * submissions per assignment (assignment, rate basis, submitted amount, approver, adjustment
 * history, export status) and, where the API lists `submit_fee`, a submission for a completed
 * assignment (`POST /v1/fee-submissions`). States read "Submitted", "Approved", "Exported", never
 * "Paid". Rates are DEC-011 (pending): the official enters the rate basis they were given; the API
 * computes the amount from it and rejects an amount outside it.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import { SelectField, TextField, fieldErrorsOf } from '../../features/operations/fields';
import { formatMoney, formatRange, humanize, parseMinor } from '../../features/operations/format';
import { FEE_STATUS } from '../../features/operations/labels';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { FeeHistory, rateBasisText } from '../staff/FeeApprovalsScreen';
import { MY_ASSIGNMENTS_KEY, type WorkspaceAssignment } from './MyAssignment';

type RateBasis = Schema<'RateBasis'>;

export function MyFeesScreen() {
  const assignments = useApiQuery({
    path: '/me/assignments',
    request: { query: { status: 'completed' } },
  });
  return (
    <section aria-labelledby="my-fees-title">
      <h2 id="my-fees-title">Hours and fees</h2>
      <AreaTabs label="Workspace screens" tabs={WORKSPACE_TABS} />
      <OfflineQueueStatus reviewPath="/workspace/offline" />
      <p className="caption">
        Approved fees go to payment administration; this system does not pay anyone.
      </p>
      <QueryBoundary
        query={assignments}
        label="your completed assignments"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No completed assignments',
          description: 'You can submit hours or a fee once an assignment is marked completed.',
        }}
        unavailableOffline={['submitting a fee']}
      >
        {(data) => (
          <ul className="ops-cards" aria-label="Completed assignments">
            {data.items.map((item) => (
              <FeeCard key={item.assignment.id} item={item} />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

function FeeCard({ item }: { item: WorkspaceAssignment }) {
  const fee = item.fee;
  const canSubmit = item.availableActions.includes('submit_fee');
  return (
    <li aria-label={item.activity.title}>
      <span className="row-title">{item.activity.title}</span>
      <span className="caption">
        {formatRange(
          item.activity.scheduledStart,
          item.activity.scheduledEnd,
          item.activity.facility?.timezone ?? null,
        )}{' '}
        · {humanize(item.assignment.role)}
      </span>
      {fee ? (
        <>
          <StatusBadge tone={FEE_STATUS[fee.status].tone} label={FEE_STATUS[fee.status].label} />
          <span>{rateBasisText(fee.rateBasis, fee.currency)}</span>
          <span>
            Submitted {formatMoney(fee.submittedAmountMinor, fee.currency)}
            {fee.approvedAmountMinor !== null
              ? `; approved ${formatMoney(fee.approvedAmountMinor, fee.currency)}`
              : ''}
          </span>
          <FeeHistory fee={fee} />
        </>
      ) : (
        <span className="caption">No fee submitted.</span>
      )}
      {canSubmit ? <SubmitFee item={item} /> : null}
    </li>
  );
}

function SubmitFee({ item }: { item: WorkspaceAssignment }) {
  const { online } = useApp();
  const [kind, setKind] = useState<RateBasis['kind'] | ''>('');
  const [currency, setCurrency] = useState('');
  const [rate, setRate] = useState('');
  const [minutes, setMinutes] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const command = useApiCommand('post', '/fee-submissions', { invalidate: [MY_ASSIGNMENTS_KEY] });
  const apiErrors = fieldErrorsOf(command.error);
  const title = item.activity.title;

  const submit = () => {
    const next: Record<string, string> = {};
    const code = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code))
      next.currency = 'Enter the three-letter currency code, for example USD.';
    if (!kind) next.kind = 'Choose the rate basis.';
    const rateMinor = code ? parseMinor(rate, code) : null;
    const amountMinor = code ? parseMinor(amount, code) : null;
    if (kind && rateMinor === null) next.rate = 'Enter the rate as an amount, for example 25.00.';
    if (kind === 'hourly' && !/^\d{1,4}$/.test(minutes.trim()))
      next.minutes = 'Enter the minutes worked.';
    if (amountMinor === null) next.amount = 'Enter the amount you are submitting.';
    setProblems(next);
    if (Object.keys(next).length > 0 || rateMinor === null || amountMinor === null || !kind) return;
    const ref = reference.trim() ? { rateReference: reference.trim() } : {};
    const rateBasis: RateBasis =
      kind === 'hourly'
        ? { kind, rateMinor, minutes: Number(minutes.trim()), ...ref }
        : kind === 'flat'
          ? { kind, amountMinor: rateMinor, ...ref }
          : { kind, rateMinor, ...ref };
    void command
      .submit({
        body: {
          assignmentId: item.assignment.id,
          rateBasis,
          submittedAmountMinor: amountMinor,
          currency: code,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };

  if (command.data) {
    return <CommandSuccess label={FEE_STATUS[command.data.status].label} />;
  }
  return (
    <form
      className="ops-form"
      aria-label={`Submit hours or a fee for ${title}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <StateView
        variant="pending-decision"
        subject="Fee rates"
        decisions={['DEC-011']}
        owner="Operations/finance"
      />
      <TextField
        label="Currency"
        value={currency}
        onChange={setCurrency}
        error={problems.currency ?? apiErrors.currency}
      />
      <SelectField
        label="Rate basis"
        value={kind}
        onChange={(v) => setKind(v as RateBasis['kind'] | '')}
        placeholder="Choose"
        options={[
          { value: 'per_assignment', label: 'Per assignment' },
          { value: 'hourly', label: 'Hourly' },
          { value: 'flat', label: 'Flat amount' },
        ]}
        error={problems.kind}
      />
      {kind ? (
        <TextField
          label={
            kind === 'hourly'
              ? 'Rate per hour'
              : kind === 'flat'
                ? 'Flat amount'
                : 'Rate per assignment'
          }
          value={rate}
          onChange={setRate}
          inputMode="decimal"
          error={
            problems.rate ?? apiErrors['rateBasis.rateMinor'] ?? apiErrors['rateBasis.amountMinor']
          }
        />
      ) : null}
      {kind === 'hourly' ? (
        <TextField
          label="Minutes worked"
          value={minutes}
          onChange={setMinutes}
          inputMode="numeric"
          error={problems.minutes ?? apiErrors['rateBasis.minutes']}
        />
      ) : null}
      <TextField
        label="Rate reference (optional)"
        value={reference}
        onChange={setReference}
        hint="Where the rate comes from, for example the rate card you were given."
      />
      <TextField
        label="Amount submitted"
        value={amount}
        onChange={setAmount}
        inputMode="decimal"
        error={problems.amount ?? apiErrors.submittedAmountMinor}
      />
      <TextField label="Note (optional)" value={note} onChange={setNote} />
      <Button type="submit" busy={command.isProcessing} disabled={!online}>
        Submit
      </Button>
      {!online ? (
        <span className="caption">Submitting needs a connection; what you entered stays here.</span>
      ) : null}
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} />
      ) : null}
    </form>
  );
}
