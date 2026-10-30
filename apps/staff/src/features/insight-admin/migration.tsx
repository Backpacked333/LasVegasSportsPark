/**
 * Shared parts of SCR-S-48 Migration imports and reconciliation (§5.4, §5.5, §5.6, SPK-AT-024,
 * DEC-014, DEC-067; SPK-UX-008): review-queue exceptions with their decision form, and a
 * reconciliation report with its four levels, discrepancies (never netted) and per-area approvals.
 * Staged payloads are never rendered: a row is shown by entity type, external id, outcome and
 * reasons only, so imported personal and child data is not repeated on screen (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { CommandError, CommandSuccess, PendingNote } from './feedback';
import { CheckboxGroup, RadioGroup, SelectField, TextField } from './fields';
import { formatInstant, formatMinor, formatScalar, shortId } from './format';
import {
  APPROVAL_BADGES,
  DECISIONS,
  ENTITY_TYPE_LABELS,
  EXCEPTION_KIND_LABELS,
  EXCEPTION_STATUS_BADGES,
  GRANT_PERMISSION_LABELS,
  RECONCILIATION_AREA_LABELS,
  RECONCILIATION_BADGES,
  RECONCILIATION_LEVEL_LABELS,
  roleLabel,
} from './labels';

type ImportException = Schema<'ImportException'>;
type Report = Schema<'MigrationReconciliationReport'>;

export const EXCEPTIONS_KEY = ['api', '/import-exceptions'] as const;
export const BATCH_KEY = ['api', '/import-batches/{id}'] as const;
export const BATCHES_KEY = ['api', '/import-batches'] as const;

export function ReasonList({ reasons }: { reasons: readonly Schema<'ImportReason'>[] }) {
  if (reasons.length === 0) return null;
  return (
    <ul className="caption" aria-label="Reasons">
      {reasons.map((reason, index) => (
        <li key={`${reason.code}-${index}`}>
          {reason.code}: {reason.message}
        </li>
      ))}
    </ul>
  );
}

const PERMISSION_OPTIONS = Object.entries(GRANT_PERMISSION_LABELS).map(([value, label]) => ({
  value,
  label,
}));

function DecideException({ exception }: { exception: ImportException }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const decide = useApiCommand('post', '/import-exceptions/{id}/decide', {
    invalidate: [EXCEPTIONS_KEY, BATCH_KEY],
  });
  const ambiguity =
    exception.kind === 'ambiguous_relationship' || exception.kind === 'ambiguous_balance';
  const options = [
    ...(ambiguity ? [{ value: 'accept', label: 'Accept' }] : []),
    { value: 'reject', label: 'Reject' },
    { value: 'defer', label: 'Defer' },
  ];

  const build = () => {
    const next: Record<string, string> = {};
    if (!decision) next.decision = 'Choose a decision.';
    if (!reason.trim()) next.reason = 'Enter the reason for this decision.';
    let resolution: Schema<'ImportExceptionResolution'> | undefined;
    if (
      decision === 'accept' &&
      exception.kind === 'ambiguous_relationship' &&
      permissions.length > 0
    ) {
      resolution = { permissions: permissions as Schema<'GrantPermission'>[] };
    }
    if (decision === 'accept' && exception.kind === 'ambiguous_balance' && amount.trim()) {
      // The approved amount is entered in minor units of the staged balance's currency (MIG-01
      // names it on the exception); it is formatted for display only, never converted.
      const minor = /^\d{1,15}$/.test(amount.trim()) ? Number(amount.trim()) : null;
      if (minor === null || minor < 1)
        next.amount =
          'Enter the approved amount as a whole number of minor units, for example 2500.';
      else resolution = { amountMinor: minor };
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      decision: decision as Schema<'ImportExceptionDecision'>,
      reason: reason.trim(),
      expectedRevision: exception.revision,
      ...(resolution ? { resolution } : {}),
    };
  };
  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void decide
      .submit({ path: { id: exception.id }, body })
      .then((decided) => setSuccess(`Exception ${decided.status}: ${decided.decision ?? ''}`))
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const reload = () => {
    decide.reset();
    void queryClient.invalidateQueries({ queryKey: EXCEPTIONS_KEY });
  };
  return (
    <form
      className="ia-form"
      onSubmit={submit}
      aria-label={`Decide exception ${shortId(exception.id)}`}
      noValidate
    >
      <RadioGroup
        legend="Decision"
        name={`decision-${exception.id}`}
        required
        value={decision}
        onChange={setDecision}
        options={options}
        hint={
          ambiguity
            ? 'Accepting may narrow what was staged, never widen it.'
            : 'Validation errors and conflicts can only be rejected or deferred.'
        }
        error={errors.decision}
      />
      {decision === 'accept' && exception.kind === 'ambiguous_relationship' ? (
        <CheckboxGroup
          legend="Permissions approved for import"
          options={PERMISSION_OPTIONS}
          selected={permissions}
          onChange={setPermissions}
          hint="Leave all unticked to accept what was staged; tick a subset to narrow it."
        />
      ) : null}
      {decision === 'accept' && exception.kind === 'ambiguous_balance' ? (
        <>
          <TextField
            label={`Approved amount in minor units of ${exception.currency ?? "the staged balance's currency"}`}
            inputMode="numeric"
            value={amount}
            onChange={setAmount}
            hint={`For example cents: 2500 for 25.00. Leave empty to accept the staged amount${
              exception.stagedAmountMinor !== null
                ? ` (${formatMinor(exception.stagedAmountMinor, exception.currency)})`
                : ''
            }.`}
            error={errors.amount}
          />
          {/^\d{1,15}$/.test(amount.trim()) && Number(amount.trim()) > 0 ? (
            <p className="caption" role="status">
              Records amountMinor {Number(amount.trim())}
              {exception.currency
                ? `: ${formatMinor(Number(amount.trim()), exception.currency)}`
                : " in the staged balance's currency (not stated)"}
              .
            </p>
          ) : null}
        </>
      ) : null}
      <TextField
        label="Reason"
        required
        value={reason}
        onChange={setReason}
        error={errors.reason}
      />
      <div>
        <Button type="submit" busy={decide.isProcessing} disabled={!online}>
          Record decision
        </Button>
      </div>
      <CommandSuccess message={success} />
      <CommandError
        error={decide.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
        onReload={reload}
      />
    </form>
  );
}

export function ExceptionCard({ exception }: { exception: ImportException }) {
  const [open, setOpen] = useState(false);
  const badge = EXCEPTION_STATUS_BADGES[exception.status];
  return (
    <li aria-labelledby={`exception-${exception.id}`}>
      <div className="row-text">
        <span className="row-title" id={`exception-${exception.id}`}>
          {EXCEPTION_KIND_LABELS[exception.kind]}: {ENTITY_TYPE_LABELS[exception.entityType]}{' '}
          {exception.externalId}
        </span>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span className="caption">
          Review owner: {roleLabel(exception.reviewOwnerRole)} · {exception.phase} phase · raised{' '}
          {formatInstant(exception.createdAt)} · batch {shortId(exception.batchId)}
        </span>
        {exception.stagedAmountMinor !== null ? (
          <span className="caption">
            Staged amount {formatMinor(exception.stagedAmountMinor, exception.currency)}
          </span>
        ) : null}
        <ReasonList reasons={exception.reasons} />
        {exception.resolution?.amountMinor !== undefined ? (
          <span className="caption">
            Approved amount {formatMinor(exception.resolution.amountMinor, exception.currency)}
          </span>
        ) : null}
        {exception.decision ? (
          <span className="caption">
            Decision: {exception.decision}
            {exception.decisionReason ? ` (${exception.decisionReason})` : ''}
            {exception.decidedBy ? ` by ${exception.decidedBy.actorLabel}` : ''}
            {exception.decidedAt ? `, ${formatInstant(exception.decidedAt)}` : ''}
          </span>
        ) : null}
      </div>
      {exception.status === 'open' ? (
        <>
          <Button
            variant="secondary"
            aria-expanded={open}
            aria-label={`Decide ${EXCEPTION_KIND_LABELS[exception.kind]} ${exception.externalId}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Close decision' : 'Decide'}
          </Button>
          {open ? <DecideException exception={exception} /> : null}
        </>
      ) : null}
    </li>
  );
}

function ApproveArea({ report }: { report: Report }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const decided = new Set(report.approvals.map((a) => a.area));
  const open = report.requiredAreas.filter((area) => !decided.has(area));
  const [area, setArea] = useState('');
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const approve = useApiCommand('post', '/import-reconciliation-reports/{id}/approvals', {
    invalidate: [['api', '/import-reconciliation-reports/{id}']],
  });
  if (report.approvalStatus !== 'pending' || open.length === 0) {
    return <CommandSuccess message={success} />;
  }
  const build = () => {
    const next: Record<string, string> = {};
    if (!area) next.area = 'Choose the area you approve for.';
    if (!decision) next.decision = 'Choose approve or reject.';
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      area: area as Schema<'ReconciliationArea'>,
      decision: decision as 'approved' | 'rejected',
      expectedRevision: report.revision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
  };
  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void approve
      .submit({ path: { id: report.id }, body })
      .then((next) => {
        // A confirmed outcome naming the resulting state; the decided area leaves the form, so
        // it can never be sent again as a new intent.
        setSuccess(
          `${RECONCILIATION_AREA_LABELS[body.area]} ${body.decision}; sign-off ${next.approvalStatus}.`,
        );
        setArea('');
        setDecision('');
        setReason('');
      })
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const reload = () => {
    approve.reset();
    void queryClient.invalidateQueries({
      queryKey: ['api', '/import-reconciliation-reports/{id}'],
    });
  };
  return (
    <form className="ia-form" onSubmit={submit} aria-label="Record an area sign-off" noValidate>
      <h4>Record an area sign-off</h4>
      <SelectField
        label="Area"
        required
        value={area}
        onChange={setArea}
        placeholder="Choose an area"
        options={open.map((a) => ({ value: a, label: RECONCILIATION_AREA_LABELS[a] }))}
        error={errors.area}
      />
      <RadioGroup
        legend="Decision"
        name="area-decision"
        required
        value={decision}
        onChange={setDecision}
        options={[
          { value: 'approved', label: 'Approve' },
          { value: 'rejected', label: 'Reject' },
        ]}
        error={errors.decision}
      />
      <TextField
        label="Reason"
        value={reason}
        onChange={setReason}
        hint="Needed to reject, or to approve an area with discrepancies; they stay listed and are never netted."
      />
      <div>
        <Button type="submit" busy={approve.isProcessing} disabled={!online}>
          Record sign-off
        </Button>
      </div>
      <CommandSuccess message={success} />
      <CommandError
        error={approve.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
        onReload={reload}
      />
    </form>
  );
}

function discrepancyDifference(d: Schema<'MigrationDiscrepancy'>): string {
  if (d.differenceMinor !== null) return formatMinor(d.differenceMinor, d.currency);
  if (d.countDifference !== null) return formatScalar(d.countDifference);
  return 'none';
}

export function ReconciliationReportView({ report }: { report: Report }) {
  const status = RECONCILIATION_BADGES[report.status];
  const approval = APPROVAL_BADGES[report.approvalStatus];
  return (
    <article className="ia-report" aria-labelledby={`reconciliation-${report.id}`}>
      <h3 id={`reconciliation-${report.id}`}>
        Reconciliation report {shortId(report.id)} for batch {shortId(report.batchId)}
      </h3>
      <p>
        <StatusBadge tone={status.tone} label={status.label} />{' '}
        <StatusBadge tone={approval.tone} label={`sign-off ${approval.label}`} />{' '}
        <span className="caption">
          Generated {formatInstant(report.generatedAt)} by {report.generatedBy.actorLabel} ·{' '}
          {report.discrepancyCount} discrepanc{report.discrepancyCount === 1 ? 'y' : 'ies'}
        </span>
      </p>
      {report.supersededByReportId ? (
        <p className="caption">
          Superseded by report {shortId(report.supersededByReportId)}; this one is kept as evidence.
        </p>
      ) : null}
      <div className="ia-table-wrap" role="region" aria-label="Reconciliation levels" tabIndex={0}>
        <table className="ia-table">
          <caption>Four reconciliation levels (§5.5)</caption>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">Status</th>
              <th scope="col">Checked</th>
              <th scope="col">Discrepancies</th>
            </tr>
          </thead>
          <tbody>
            {report.levels.map((level) => {
              const badge = RECONCILIATION_BADGES[level.status];
              return (
                <tr key={level.level}>
                  <th scope="row">{RECONCILIATION_LEVEL_LABELS[level.level]}</th>
                  <td>
                    <StatusBadge tone={badge.tone} label={badge.label} />
                  </td>
                  <td>{level.checked}</td>
                  <td>{level.discrepancyCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {report.discrepancies.length > 0 ? (
        <div className="ia-table-wrap" role="region" aria-label="Discrepancies" tabIndex={0}>
          <table className="ia-table">
            <caption>Discrepancies, each on its own and never netted</caption>
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Area</th>
                <th scope="col">Records</th>
                <th scope="col">Code</th>
                <th scope="col">External id</th>
                <th scope="col">Expected</th>
                <th scope="col">Actual</th>
                <th scope="col">Difference</th>
              </tr>
            </thead>
            <tbody>
              {report.discrepancies.map((d) => (
                <tr key={d.id}>
                  <td>{RECONCILIATION_LEVEL_LABELS[d.level]}</td>
                  <td>{RECONCILIATION_AREA_LABELS[d.area]}</td>
                  <td>{ENTITY_TYPE_LABELS[d.entityType]}</td>
                  <td>{d.code}</td>
                  <td>{d.externalId ?? 'none'}</td>
                  <td>{formatScalar(d.expected)}</td>
                  <td>{formatScalar(d.actual)}</td>
                  <td>{discrepancyDifference(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <section className="ia-section" aria-label="Area sign-offs">
        <h4>Area sign-offs</h4>
        <PendingNote
          decisions={DECISIONS.reconciliationSignOff.ids}
          owner={DECISIONS.reconciliationSignOff.owner}
        >
          Who signs off each area at cutover is proposed (finance approves opening balances, program
          and league owners approve participation, operations approves the schedule).
        </PendingNote>
        <p className="caption">
          Required:{' '}
          {report.requiredAreas.map((a) => RECONCILIATION_AREA_LABELS[a]).join(', ') || 'none'}
        </p>
        {report.approvals.length > 0 ? (
          <ul aria-label="Recorded sign-offs">
            {report.approvals.map((a) => (
              <li key={a.area}>
                {RECONCILIATION_AREA_LABELS[a.area]}: {a.decision} by {roleLabel(a.approverRole)},{' '}
                {formatInstant(a.decidedAt)}
                {a.acknowledgedDiscrepancies > 0
                  ? ` (${a.acknowledgedDiscrepancies} discrepancies acknowledged)`
                  : ''}
                {a.reason ? `: ${a.reason}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="caption">No area is signed off yet.</p>
        )}
        <ApproveArea report={report} />
      </section>
    </article>
  );
}
