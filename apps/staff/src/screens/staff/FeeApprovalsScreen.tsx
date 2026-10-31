/**
 * SCR-S-34 Fee and hours approvals (SPK-STAFF-006, §1.7, DEC-011, DEC-052, DEC-022).
 *
 * - Each submission shows its assignment, rate basis, computed and submitted amounts, approver,
 *   adjustment history and export status (`GET /v1/fee-submissions`).
 * - Approve as submitted, approve with an adjusted amount (a new adjustment row with the reason),
 *   or reject with a reason; each submission is its own command with the expected revision, so a
 *   batch of approvals completes per submission.
 * - Exporting approved fees (`POST /v1/fee-export-batches`) hands them to payment administration;
 *   no payroll is executed (§1.7). A timed-out export has an unknown outcome and is retried with
 *   the same idempotency key, never re-created. The payroll boundary and the export target are
 *   DEC-052 / DEC-022 (pending). Rates are DEC-011 (pending): nothing here invents a rate.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, STAFF_TABS } from '../../features/operations/AreaTabs';
import { useKeyedCommands } from '../../features/operations/commands';
import { nameOf, usePersonNames } from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  SelectField,
  TextAreaField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import {
  formatInstant,
  formatMoney,
  formatRange,
  humanize,
  parseMinor,
} from '../../features/operations/format';
import { FEE_STATUS } from '../../features/operations/labels';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type FeeSubmission = Schema<'FeeSubmission'>;
type FeeStatus = Schema<'FeeSubmissionStatus'>;
type RateBasis = Schema<'RateBasis'>;

/** Workforce FeeSubmissionMachine transitions an approver may request. */
const FEE_ACTIONS: Record<FeeStatus, readonly ('approve' | 'adjust' | 'reject')[]> = {
  submitted: ['approve', 'adjust', 'reject'],
  approved: ['adjust'],
  adjusted: ['adjust'],
  rejected: [],
  exported: [],
};
const FEES_KEY = ['api', '/fee-submissions'] as const;

export function rateBasisText(basis: RateBasis, currency: string): string {
  const ref = basis.rateReference ? ` (${basis.rateReference})` : '';
  switch (basis.kind) {
    case 'per_assignment':
      return `Per assignment: ${formatMoney(basis.rateMinor, currency)}${ref}`;
    case 'hourly':
      return `Hourly: ${formatMoney(basis.rateMinor, currency)} per hour for ${basis.minutes} minutes${ref}`;
    case 'flat':
      return `Flat amount: ${formatMoney(basis.amountMinor, currency)}${ref}`;
  }
}

export function FeeHistory({ fee }: { fee: FeeSubmission }) {
  return (
    <ol className="ops-history" aria-label="Fee history">
      <li>
        Submitted {formatInstant(fee.submittedAt)}:{' '}
        {formatMoney(fee.submittedAmountMinor, fee.currency)}
      </li>
      {fee.adjustments.map((a) => (
        <li key={a.id}>
          Adjusted {formatInstant(a.adjustedAt)} by {a.adjustedBy.actorLabel}:{' '}
          {formatMoney(a.previousAmountMinor, a.currency)} to{' '}
          {formatMoney(a.adjustedAmountMinor, a.currency)}. Reason: {a.reason}
        </li>
      ))}
      {fee.approvedAt ? (
        <li>
          Approved {formatInstant(fee.approvedAt)}
          {fee.approver ? ` by ${fee.approver.actorLabel}` : ''}
          {fee.approvedAmountMinor !== null
            ? `: ${formatMoney(fee.approvedAmountMinor, fee.currency)}`
            : ''}
        </li>
      ) : null}
      {fee.rejectedAt ? (
        <li>
          Rejected {formatInstant(fee.rejectedAt)}: {fee.rejectionReason}
        </li>
      ) : null}
      {fee.exportedAt ? (
        <li>
          Exported {formatInstant(fee.exportedAt)} for payment administration (not paid by this
          system)
        </li>
      ) : null}
    </ol>
  );
}

export function FeeApprovalsScreen() {
  const [status, setStatus] = useState<FeeStatus | ''>('submitted');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useApiQuery({
    path: '/fee-submissions',
    request: { query: { status: status || undefined, limit: 50, cursor } },
  });
  const names = usePersonNames(
    useMemo(() => (list.data?.items ?? []).map((f) => f.personId), [list.data]),
  );
  return (
    <section aria-labelledby="fees-title">
      <h2 id="fees-title">Fee and hours approvals</h2>
      <AreaTabs label="Staff and officials screens" tabs={STAFF_TABS} />
      <StateView
        variant="pending-decision"
        subject="Fee rates and the payroll boundary"
        decisions={['DEC-011', 'DEC-052']}
        owner="Operations/finance"
      />
      <p className="caption">
        Approved fees support payment administration; this system does not pay anyone or run
        payroll.
      </p>
      <SelectField
        label="Show"
        value={status}
        onChange={(v) => {
          setStatus(v as FeeStatus | '');
          setCursor(undefined);
        }}
        placeholder="Every state"
        options={(Object.keys(FEE_STATUS) as FeeStatus[]).map((s) => ({
          value: s,
          label: FEE_STATUS[s].label,
        }))}
      />
      <QueryBoundary
        query={list}
        label="fee submissions"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'Nothing submitted',
          description: 'Fee and hours submissions from officials and coaches appear here.',
        }}
        unavailableOffline={['approving, adjusting, rejecting and exporting fees']}
      >
        {(data) => (
          <>
            <ul className="list" aria-label="Fee submissions">
              {data.items.map((fee) => (
                <FeeRow key={fee.id} fee={fee} name={nameOf(names, fee.personId)} />
              ))}
            </ul>
            {data.nextCursor ? (
              <Button variant="secondary" onClick={() => setCursor(data.nextCursor ?? undefined)}>
                Next page
              </Button>
            ) : null}
          </>
        )}
      </QueryBoundary>
      <ExportBatch currencies={[...new Set((list.data?.items ?? []).map((f) => f.currency))]} />
    </section>
  );
}

function FeeRow({ fee, name }: { fee: FeeSubmission; name: string }) {
  const assignment = useApiQuery({
    path: '/assignments/{id}',
    request: { path: { id: fee.assignmentId } },
  });
  const commands = useKeyedCommands({ invalidate: [FEES_KEY] });
  const [mode, setMode] = useState<'adjust' | 'reject' | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const badge = FEE_STATUS[fee.status];
  const actions = FEE_ACTIONS[fee.status];
  const outcome = (k: string) => commands.outcome(`${k}|${fee.id}`);
  const failedKind = (['approve', 'adjust', 'reject'] as const).find((k) => outcome(k).error);
  const error = failedKind ? outcome(failedKind).error : undefined;
  const queryClient = useQueryClient();
  // Stale version (SPK-UX-008): clear the refusal and re-read the list, so the next attempt
  // carries the current revision as a new intent.
  const reload = () => {
    if (failedKind) commands.reset(`${failedKind}|${fee.id}`);
    void queryClient.invalidateQueries({ queryKey: FEES_KEY });
  };
  const differs = fee.submittedAmountMinor !== fee.computedAmountMinor;
  const a = assignment.data;
  const title = a ? `${a.targetTitle}: ${humanize(a.role)}` : 'Assignment';

  const approve = () =>
    void commands.run(`approve|${fee.id}`, 'post', '/fee-submissions/{id}/approve', {
      path: { id: fee.id },
      body: { expectedRevision: fee.revision },
    });
  const confirm = () => {
    const next: Record<string, string> = {};
    if (!reason.trim()) next.reason = 'A reason is required.';
    const minor = mode === 'adjust' ? parseMinor(amount, fee.currency) : null;
    if (mode === 'adjust' && minor === null)
      next.amount = `Enter an amount in ${fee.currency}, for example 25.00.`;
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    if (mode === 'adjust' && minor !== null) {
      void commands.run(`adjust|${fee.id}`, 'post', '/fee-submissions/{id}/adjust', {
        path: { id: fee.id },
        body: { amountMinor: minor, reason: reason.trim(), expectedRevision: fee.revision },
      });
    } else if (mode === 'reject') {
      void commands.run(`reject|${fee.id}`, 'post', '/fee-submissions/{id}/reject', {
        path: { id: fee.id },
        body: { reason: reason.trim(), expectedRevision: fee.revision },
      });
    }
  };
  return (
    <li aria-label={`${name}: ${title}`}>
      <div className="row-text">
        <span className="row-title">
          {name}: {title}
        </span>
        {a ? (
          <span className="caption">{formatRange(a.scheduledStart, a.scheduledEnd)}</span>
        ) : null}
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span>{rateBasisText(fee.rateBasis, fee.currency)}</span>
        <span>
          Submitted {formatMoney(fee.submittedAmountMinor, fee.currency)}; computed from the rate
          basis {formatMoney(fee.computedAmountMinor, fee.currency)}
        </span>
        {differs ? (
          <StatusBadge tone="warning" label="Submitted amount differs from the rate basis" />
        ) : null}
        {fee.note ? <span className="caption">Note: {fee.note}</span> : null}
        <span className="caption">
          Export:{' '}
          {fee.exportBatchId
            ? `exported ${fee.exportedAt ? formatInstant(fee.exportedAt) : ''}`
            : 'not exported'}
        </span>
        <FeeHistory fee={fee} />
      </div>
      {actions.length > 0 ? (
        <div className="ops-actions">
          {actions.includes('approve') ? (
            <Button
              busy={outcome('approve').status === 'pending'}
              aria-label={`Approve ${name}: ${title}`}
              onClick={approve}
            >
              Approve
            </Button>
          ) : null}
          {actions.includes('adjust') ? (
            <Button
              variant="secondary"
              aria-label={`Adjust ${name}: ${title}`}
              onClick={() => setMode('adjust')}
            >
              Approve with adjustment
            </Button>
          ) : null}
          {actions.includes('reject') ? (
            <Button
              variant="secondary"
              aria-label={`Reject ${name}: ${title}`}
              onClick={() => setMode('reject')}
            >
              Reject
            </Button>
          ) : null}
        </div>
      ) : null}
      {mode ? (
        <form
          className="ops-form"
          aria-label={
            mode === 'adjust' ? `Adjust the fee for ${name}` : `Reject the fee for ${name}`
          }
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          {mode === 'adjust' ? (
            <TextField
              label={`Approved amount (${fee.currency})`}
              value={amount}
              onChange={setAmount}
              inputMode="decimal"
              required
              error={problems.amount ?? fieldErrorsOf(outcome('adjust').error).amountMinor}
            />
          ) : null}
          <TextAreaField
            label="Reason"
            value={reason}
            onChange={setReason}
            required
            error={problems.reason}
          />
          <div className="ops-actions">
            <Button type="submit" busy={outcome(mode).status === 'pending'}>
              {mode === 'adjust' ? 'Approve adjusted amount' : 'Confirm rejection'}
            </Button>
            <Button variant="secondary" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <CommandError
          error={error}
          onRetry={failedKind === 'approve' ? approve : failedKind ? confirm : undefined}
          onReload={reload}
          subject="This submission"
        />
      ) : null}
    </li>
  );
}

function ExportBatch({ currencies }: { currencies: string[] }) {
  const [currency, setCurrency] = useState('');
  const [note, setNote] = useState('');
  const command = useApiCommand('post', '/fee-export-batches', { invalidate: [FEES_KEY] });
  const chosen = currency || (currencies.length === 1 ? (currencies[0] as string) : '');
  const submit = () => {
    if (!chosen) return;
    void command
      .submit({ body: { currency: chosen, ...(note.trim() ? { note: note.trim() } : {}) } })
      .catch(() => undefined);
  };
  const batch = command.data;
  return (
    <section className="ops-section" aria-labelledby="export-title">
      <h3 id="export-title">Export approved fees</h3>
      <p className="caption">
        Every approved or adjusted submission in the currency not yet exported. The export target is
        pending (DEC-022).
      </p>
      <form
        className="ops-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Currency"
          value={chosen}
          onChange={(v) => setCurrency(v.toUpperCase())}
          hint="ISO code, for example USD."
        />
        <TextField label="Note (optional)" value={note} onChange={setNote} />
        <Button type="submit" busy={command.isProcessing} disabled={!chosen}>
          Export
        </Button>
      </form>
      {command.error ? (
        <CommandError error={command.error} onRetry={submit} subject="This export" />
      ) : null}
      {batch ? (
        <CommandSuccess
          label={`Exported: ${batch.submissionCount} submission${batch.submissionCount === 1 ? '' : 's'}`}
        >
          <span>
            Total {formatMoney(batch.totalMinor, batch.currency)}, created{' '}
            {formatInstant(batch.createdAt)} by {batch.createdBy.actorLabel}. Not paid by this
            system.
          </span>
        </CommandSuccess>
      ) : null}
    </section>
  );
}
