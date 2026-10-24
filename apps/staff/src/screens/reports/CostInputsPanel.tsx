/**
 * SCR-S-44 agreed cost inputs (SPK-REPORT-004 "profit or contribution margin requires agreed cost
 * inputs"; metric dictionary E4; DEC-085). Lists the agreed direct cost per activity hour for the
 * chosen facility (`GET /v1/reports/cost-inputs`), records a new one with its approval reference
 * (`POST /v1/reports/cost-inputs`, Idempotency-Key per intent) and withdraws one with a reason and
 * the expected revision (`POST /v1/reports/cost-inputs/{id}/withdraw`). Amounts are entered in
 * major units of the currency typed by the operator and sent as integer minor units; no currency,
 * amount or date is preset. The API decides who may read or record them.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
  fieldErrorsOf,
} from '../../features/insight-admin/feedback';
import { TextField } from '../../features/insight-admin/fields';
import {
  formatInstant,
  formatMinor,
  minorDigits,
  parseMajorToMinor,
  UUID_PATTERN,
} from '../../features/insight-admin/format';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';

type CostInput = Schema<'CostInput'>;

const COST_INPUTS_KEY = ['api', '/reports/cost-inputs'] as const;

function WithdrawCostInput({ input }: { input: CostInput }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const withdraw = useApiCommand('post', '/reports/cost-inputs/{id}/withdraw', {
    invalidate: [COST_INPUTS_KEY],
  });
  const send = () =>
    void withdraw
      .submit({
        path: { id: input.id },
        body: { reason: reason.trim(), expectedRevision: input.revision },
      })
      .then(() => setOpen(false))
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError('Enter the reason for withdrawing this cost input.');
      return;
    }
    setError(null);
    send();
  };
  const reload = () => {
    withdraw.reset();
    void queryClient.invalidateQueries({ queryKey: COST_INPUTS_KEY });
  };
  if (!open) {
    return (
      <Button
        variant="secondary"
        disabled={!online}
        aria-label={`Withdraw cost input ${input.description}`}
        onClick={() => setOpen(true)}
      >
        Withdraw
      </Button>
    );
  }
  return (
    <form
      className="ia-form"
      onSubmit={submit}
      aria-label={`Withdraw ${input.description}`}
      noValidate
    >
      <TextField
        label="Reason for withdrawing"
        required
        value={reason}
        onChange={setReason}
        error={error}
      />
      <div className="ia-actions">
        <Button type="submit" busy={withdraw.isProcessing} disabled={!online}>
          Confirm withdrawal
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      <CommandError error={withdraw.error} onRetry={send} onReload={reload} />
    </form>
  );
}

interface DraftCostInput {
  resourceId: string;
  amount: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string;
  description: string;
  approvalReference: string;
}

const EMPTY: DraftCostInput = {
  resourceId: '',
  amount: '',
  currency: '',
  effectiveFrom: '',
  effectiveTo: '',
  description: '',
  approvalReference: '',
};

function RecordCostInput({ facilityId }: { facilityId: string }) {
  const { online } = useApp();
  const [draft, setDraft] = useState<DraftCostInput>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const record = useApiCommand('post', '/reports/cost-inputs', { invalidate: [COST_INPUTS_KEY] });
  const set = (patch: Partial<DraftCostInput>) => {
    setSuccess(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const build = () => {
    const next: Record<string, string> = {};
    const currency = draft.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || minorDigits(currency) === null) {
      next.currency = 'Enter a three-letter currency code (ISO 4217).';
    }
    const amountMinor = next.currency ? null : parseMajorToMinor(draft.amount, currency);
    if (!next.currency && amountMinor === null) {
      next.amount = 'Enter the agreed amount per activity hour, for example 12.50.';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.effectiveFrom))
      next.effectiveFrom = 'Enter the first day.';
    if (draft.effectiveTo && draft.effectiveTo < draft.effectiveFrom) {
      next.effectiveTo = 'The last day must not be before the first day.';
    }
    if (draft.resourceId && !UUID_PATTERN.test(draft.resourceId.trim())) {
      next.resourceId = 'Enter the space id, or leave empty for the whole facility.';
    }
    if (!draft.description.trim()) next.description = 'Describe the cost.';
    if (!draft.approvalReference.trim()) {
      next.approvalReference = 'Enter the agreement this cost comes from.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || amountMinor === null) return null;
    return {
      facilityId,
      resourceId: draft.resourceId.trim() || null,
      basis: 'per_activity_hour' as const,
      amountMinor,
      currency,
      effectiveFrom: draft.effectiveFrom,
      effectiveTo: draft.effectiveTo || null,
      description: draft.description.trim(),
      approvalReference: draft.approvalReference.trim(),
    };
  };

  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void record
      .submit({ body })
      .then((created) => {
        setDraft(EMPTY);
        setSuccess(
          `Cost input recorded: ${formatMinor(created.amountMinor, created.currency)} per activity hour, active`,
        );
      })
      .catch(() => undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const apiFields = fieldErrorsOf(record.error);
  return (
    <form className="ia-form" onSubmit={submit} aria-label="Record an agreed cost input" noValidate>
      <h4>Record an agreed cost input</h4>
      <TextField
        label="Space id"
        value={draft.resourceId}
        onChange={(resourceId) => set({ resourceId })}
        hint="Leave empty for the whole facility."
        error={errors.resourceId ?? apiFields.resourceId}
      />
      <TextField
        label="Currency"
        required
        value={draft.currency}
        onChange={(currency) => set({ currency })}
        maxLength={3}
        hint="ISO 4217 code of the agreed amount."
        error={errors.currency ?? apiFields.currency}
      />
      <TextField
        label="Amount per activity hour"
        required
        inputMode="decimal"
        value={draft.amount}
        onChange={(amount) => set({ amount })}
        error={errors.amount ?? apiFields.amountMinor}
      />
      <TextField
        label="Effective from"
        type="date"
        required
        value={draft.effectiveFrom}
        onChange={(effectiveFrom) => set({ effectiveFrom })}
        error={errors.effectiveFrom ?? apiFields.effectiveFrom}
      />
      <TextField
        label="Effective to"
        type="date"
        value={draft.effectiveTo}
        onChange={(effectiveTo) => set({ effectiveTo })}
        hint="Leave empty while the agreement stays in force."
        error={errors.effectiveTo ?? apiFields.effectiveTo}
      />
      <TextField
        label="Description"
        required
        value={draft.description}
        onChange={(description) => set({ description })}
        error={errors.description ?? apiFields.description}
      />
      <TextField
        label="Approval reference"
        required
        value={draft.approvalReference}
        onChange={(approvalReference) => set({ approvalReference })}
        hint="The Finance decision or agreement this amount comes from."
        error={errors.approvalReference ?? apiFields.approvalReference}
      />
      <div>
        <Button type="submit" busy={record.isProcessing} disabled={!online}>
          Record cost input
        </Button>
      </div>
      {!online ? <p className="caption">Recording a cost input needs a connection.</p> : null}
      <CommandSuccess message={success} />
      <CommandError
        error={record.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
      />
    </form>
  );
}

export function CostInputsPanel({ facilityId }: { facilityId: string }) {
  const inputs = useApiQuery({
    path: '/reports/cost-inputs',
    request: { query: { facilityId, includeWithdrawn: 'false' } },
    enabled: Boolean(facilityId),
  });
  if (!facilityId) return null;
  return (
    <section className="ia-section" aria-labelledby="cost-inputs-title">
      <h3 id="cost-inputs-title">Agreed cost inputs</h3>
      <p className="caption">
        Contribution margin is shown only when agreed cost inputs cover every space and event day of
        the period; it is never inferred from collections (SPK-REPORT-004).
      </p>
      <InsightQueryBoundary
        query={inputs}
        label="agreed cost inputs"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No agreed cost inputs',
          description:
            'No cost input is recorded for this facility, so contribution margin is withheld.',
        }}
        unavailableOffline={['recording or withdrawing cost inputs']}
        deniedDescription="Cost inputs are read and recorded by finance."
      >
        {(data) => (
          <ul className="list" aria-label="Agreed cost inputs">
            {data.items.map((input) => (
              <li key={input.id}>
                <div className="row-text">
                  <span className="row-title">{input.description}</span>
                  <span>
                    {formatMinor(input.amountMinor, input.currency)} per activity hour
                    {input.resourceId ? ' for one space' : ' for the whole facility'}
                  </span>
                  <span className="caption">
                    Effective {input.effectiveFrom}
                    {input.effectiveTo ? ` to ${input.effectiveTo}` : ', open-ended'} · approval{' '}
                    {input.approvalReference} · recorded by {input.approvedBy.actorLabel},{' '}
                    {formatInstant(input.recordedAt)}
                  </span>
                  <StatusBadge
                    tone={input.status === 'active' ? 'success' : 'neutral'}
                    label={input.status}
                  />
                </div>
                {input.status === 'active' ? <WithdrawCostInput input={input} /> : null}
              </li>
            ))}
          </ul>
        )}
      </InsightQueryBoundary>
      {inputs.error?.isPermissionRestriction ? null : <RecordCostInput facilityId={facilityId} />}
    </section>
  );
}
