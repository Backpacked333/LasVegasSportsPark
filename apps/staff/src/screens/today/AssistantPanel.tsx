/**
 * SCR-S-50 Operational assistant, an optional panel on Today (SPK-AUTO-001 to SPK-AUTO-005,
 * SPK-AT-026). It is closed until the viewer opens it, so Today never waits on it, and every failure
 * stays inside the panel (SPK-AUTO-005: core operations usable without it).
 *
 * - Disabled: while the API answers INTEGRATION_UNAVAILABLE with `details.reason: 'disabled'` the
 *   panel says the assistant is turned off; whether it is used is DEC-016 (product owner).
 * - Answers name every supporting record with its freshness as the API states it; missing evidence
 *   is listed as missing, never filled in (SPK-AUTO-002). A record the viewer may not see is the
 *   API's `not_available`, which never says whether it exists (SPK-AT-026).
 * - Recommendations are reviewable before anything runs (SPK-AUTO-003): what applying would do
 *   (the owning module's command, its target and input) is shown in full; approve, reject (with a
 *   reason) and apply are separate commands with the expected revision and an idempotency key, and
 *   the API decides who may do each (SPK-AUTO-004).
 * - Per organization the capability switch `assistant` (DEC-016, starts off; GET /v1/me/permissions)
 *   decides whether new questions, approvals and applies are accepted: while it is off the panel
 *   says "Assistant turned off" above the recommendations already proposed, which stay readable and
 *   can still be rejected; Ask, Approve and Apply are not offered (the API answers ACCESS_DENIED
 *   CAPABILITY_DISABLED, shown as the same turned-off state, if one is sent anyway).
 * - An apply whose outcome is unknown (its operation `recovery_required`) is never applied again;
 *   a viewer whose role holds `automation.settle_apply` records the reconciled outcome
 *   (`POST /v1/recommendations/{id}/settle-apply`: applied or not applied, the evidence in the
 *   owning module's records and a reason, with the expected revision). Settlements are listed
 *   with who recorded them. Settling is never gated by the capability (AUT-03).
 */
import {
  ApiError,
  CAPABILITY_PRESENTATION,
  apiQueryKey,
  type ApiResponse,
  type Schema,
} from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useOperation } from '../../api/useOperation';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { Facts, RadioGroup, TextAreaField } from '../../ui/FormFields';
import { LastUpdated } from '../../ui/LastUpdated';
import { RecordRef } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';

type AssistantRequest = Schema<'AssistantRequest'>;
type Recommendation = Schema<'Recommendation'>;
type Evidence = Schema<'AssistantEvidence'>;
type MissingEvidence = Schema<'AssistantMissingEvidence'>;
type Settlement = Recommendation['apply']['settlements'][number];

/** The organization's capability switch for the assistant (AUT-02, DEC-016). */
export const ASSISTANT_CAPABILITY = 'assistant' as const;
/** Recording the reconciled outcome of an unknown apply (AUT-03). */
export const SETTLE_APPLY_ACTION = 'automation.settle_apply';

export const ASSISTANT_POLL_MS = 2_000;
const RECOMMENDATIONS_KEY = ['api', '/recommendations'] as const;
/** How many recommendations of each status "Awaiting review" shows (a display limit). */
const AWAITING_PAGE = 20;
const RECOMMENDATION_KEY = ['api', '/recommendations/{id}'] as const;
const REQUEST_KEY = ['api', '/assistant/requests/{id}'] as const;

/** The assistant is switched off (SPK-AUTO-005), as opposed to temporarily unavailable. */
export function isAssistantDisabled(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.code !== 'INTEGRATION_UNAVAILABLE') return false;
  const details = error.details as { reason?: unknown } | undefined;
  return details?.reason === 'disabled';
}

const FRESHNESS_TONE: Record<Evidence['freshness'], StatusTone> = {
  live: 'success',
  recent: 'info',
  stale: 'warning',
  unknown: 'neutral',
};

const RECOMMENDATION_TONE: Record<Recommendation['status'], StatusTone> = {
  proposed: 'pending',
  approved: 'info',
  rejected: 'neutral',
  applied: 'success',
  expired: 'neutral',
};

function EvidenceList({ evidence }: { evidence: readonly Evidence[] }) {
  if (evidence.length === 0) {
    return <p className="caption">No supporting records were read.</p>;
  }
  return (
    <ul className="list" aria-label="Supporting records">
      {evidence.map((e) => (
        <li key={`${e.recordType}-${e.recordId}-${e.source}`}>
          <div className="row-text">
            <span>{e.label ?? e.recordType}</span>
            <span className="caption">
              <RecordRef type={e.recordType} id={e.recordId} /> · from {e.source} · read{' '}
              {formatDateTime(e.observedAt)}
              {e.asOf ? ` · as of ${formatDateTime(e.asOf)}` : ' · no as-of time stated'}
            </span>
            {e.changedSinceClientObservation ? (
              <span className="caption">Changed since you last saw it.</span>
            ) : null}
          </div>
          <StatusBadge tone={FRESHNESS_TONE[e.freshness]} label={`Freshness: ${e.freshness}`} />
        </li>
      ))}
    </ul>
  );
}

function MissingEvidenceList({ missing }: { missing: readonly MissingEvidence[] }) {
  if (missing.length === 0) return <p className="caption">No evidence is missing.</p>;
  return (
    <section aria-label="Missing evidence">
      <p className="caption">Missing evidence is listed here; nothing was filled in for it.</p>
      <ul className="list">
        {missing.map((m, i) => (
          <li key={`${m.recordType}-${m.recordId ?? 'none'}-${i}`}>
            <div className="row-text">
              <span>{m.description}</span>
              <span className="caption">
                {m.recordType}
                {m.source ? ` · from ${m.source}` : ''}
              </span>
            </div>
            <StatusBadge tone="warning" label={`Missing: ${m.reason}`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

const SETTLEMENT_OUTCOMES = [
  { value: 'applied', label: 'applied: the owning module’s records show the change took effect' },
  {
    value: 'not_applied',
    label: 'not_applied: the change did not take effect (it may be applied again)',
  },
] as const;

function SettlementList({ settlements }: { settlements: readonly Settlement[] }) {
  if (settlements.length === 0) return null;
  return (
    <section aria-label="Reconciled outcomes">
      <h5>Reconciled outcomes</h5>
      <ol className="list">
        {settlements.map((s) => (
          <li key={s.id}>
            <div className="row-text">
              <span className="row-title">Outcome: {s.outcome}</span>
              <span className="caption">
                {s.settledBy.actorLabel} at {formatDateTime(s.settledAt)} · operation{' '}
                {s.applyOperationId}
              </span>
              <span>Evidence: {s.evidence}</span>
              <span>Reason: {s.reason}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * AUT-03: record the reconciled outcome of an apply whose outcome was unknown, from the owning
 * module's records. Never re-runs the command; the expected revision guards a concurrent change.
 */
function SettleApplyForm({ recommendation: rec }: { recommendation: Recommendation }) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const invalidate = [RECOMMENDATIONS_KEY, RECOMMENDATION_KEY, REQUEST_KEY];
  const settle = useApiCommand('post', '/recommendations/{id}/settle-apply', { invalidate });
  const reload = () => {
    settle.reset();
    void Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
  const submit = () => {
    setSuccess(null);
    const problems: Record<string, string> = {};
    if (!outcome) problems['outcome'] = 'Choose what the owning module’s records show.';
    if (!evidence.trim()) {
      problems['evidence'] = 'Name the record that shows the outcome, for example a refund state.';
    }
    if (!reason.trim()) problems['reason'] = 'Write why this outcome is recorded now.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void settle
      .submit({
        path: { id: rec.id },
        body: {
          expectedRevision: rec.revision,
          outcome: outcome as 'applied' | 'not_applied',
          evidence: evidence.trim(),
          reason: reason.trim(),
        },
      })
      .then((r) =>
        setSuccess(`Outcome recorded. Recommendation ${r.status}; apply ${r.apply.state}.`),
      )
      .catch(() => undefined);
  };
  return (
    <form
      noValidate
      className="form"
      aria-label={`Record the reconciled outcome: ${rec.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <RadioGroup
        legend="What the owning module’s records show"
        name={`settle-outcome-${rec.id}`}
        required
        value={outcome}
        onChange={setOutcome}
        error={errors['outcome']}
        options={SETTLEMENT_OUTCOMES}
      />
      <TextAreaField
        label="Evidence"
        required
        hint="The record and its state in the owning module, for example the refund reference and its state."
        value={evidence}
        onChange={setEvidence}
        error={errors['evidence']}
        maxLength={2000}
      />
      <TextAreaField
        label="Reason"
        required
        value={reason}
        onChange={setReason}
        error={errors['reason']}
        maxLength={2000}
      />
      <Button type="submit" busy={settle.isProcessing} disabled={!online}>
        Record outcome
      </Button>
      <CommandSuccess message={success} />
      <CommandError error={settle.error} onRetry={submit} onReload={reload} />
    </form>
  );
}

function RecommendationCard({
  recommendation: rec,
  assistantOn,
}: {
  recommendation: Recommendation;
  /** The organization's `assistant` switch; undefined until GET /v1/me/permissions answers. */
  assistantOn: boolean | undefined;
}) {
  const { online } = useApp();
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const invalidate = [RECOMMENDATIONS_KEY, RECOMMENDATION_KEY, REQUEST_KEY];
  const approve = useApiCommand('post', '/recommendations/{id}/approve', { invalidate });
  const reject = useApiCommand('post', '/recommendations/{id}/reject', { invalidate });
  const apply = useApiCommand('post', '/recommendations/{id}/apply', { invalidate });
  // The card reads its own record, so two copies of one recommendation (in an answer and in
  // "Awaiting review") stay current after either is used; the newest revision wins.
  const current = useApiQuery({
    path: '/recommendations/{id}',
    request: { path: { id: rec.id } },
    staleTime: 0,
  });
  const shown = [apply.data, reject.data, approve.data, current.data].reduce<Recommendation>(
    (best, next) => (next && next.revision > best.revision ? next : best),
    rec,
  );
  // An apply whose owning command reported no outcome stays claimed; it is neither applied nor
  // failed, and must not be applied again (SPK-AUTO-004).
  const applyUnknown =
    shown.apply.lastError?.code === 'APPLY_OUTCOME_UNKNOWN' ||
    (shown.apply.lastError?.details as { outcome?: unknown } | undefined)?.outcome === 'unknown' ||
    apply.error?.nextAction === 'await_reconciliation' ||
    (apply.error?.details as { code?: unknown } | undefined)?.code === 'APPLY_OUTCOME_UNKNOWN';
  const operation = useOperation(shown.apply.operationId);
  const titleId = `recommendation-${rec.id}`;
  const busy = approve.isProcessing || reject.isProcessing || apply.isProcessing;
  const reload = () => {
    approve.reset();
    reject.reset();
    apply.reset();
    void Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
  const doApprove = () =>
    void approve
      .submit({ path: { id: rec.id }, body: { expectedRevision: shown.revision } })
      .then((r) => setSuccess(`Recommendation ${r.status}.`))
      .catch(() => undefined);
  const doReject = () => {
    if (!reason.trim()) {
      setReasonError('Write why this recommendation is rejected.');
      return;
    }
    setReasonError(null);
    void reject
      .submit({
        path: { id: rec.id },
        body: { expectedRevision: shown.revision, reason: reason.trim() },
      })
      .then((r) => setSuccess(`Recommendation ${r.status}.`))
      .catch(() => undefined);
  };
  const doApply = () =>
    void apply
      .submit({ path: { id: rec.id }, body: { expectedRevision: shown.revision } })
      .then((r) => setSuccess(`Apply ${r.apply.state}.`))
      .catch(() => undefined);
  const canReview = shown.status === 'proposed';
  const canSettle =
    applyUnknown &&
    permissions.isPermitted(
      SETTLE_APPLY_ACTION,
      shown.command?.target.facilityId ?? shown.facilityId,
    ) === true;
  const canApply =
    assistantOn === true &&
    !applyUnknown &&
    shown.status === 'approved' &&
    shown.consequential &&
    shown.command !== null &&
    shown.apply.state !== 'running' &&
    shown.apply.state !== 'applied';
  return (
    <li aria-labelledby={titleId} className="panel">
      <h4 id={titleId}>{shown.title}</h4>
      <span className="actions-row">
        <StatusBadge tone={RECOMMENDATION_TONE[shown.status]} label={`Status: ${shown.status}`} />
        <StatusBadge
          tone={shown.consequential ? 'warning' : 'info'}
          label={shown.consequential ? 'Changes records when applied' : 'Information only'}
        />
      </span>
      <p>{shown.summary}</p>
      <Facts
        items={[
          ['Kind', shown.kind],
          ['Proposed', formatDateTime(shown.proposedAt)],
          ['Reviewable until', formatDateTime(shown.expiresAt)],
          ['Apply', shown.apply.state],
        ]}
      />
      {shown.command ? (
        <details open>
          <summary>What applying would do</summary>
          <Facts
            label="Command to apply"
            items={[
              ['Command', shown.command.actionId],
              [
                'Target',
                <RecordRef
                  key="target"
                  type={shown.command.target.type}
                  id={shown.command.target.id ?? 'new'}
                />,
              ],
              ...Object.entries(shown.command.input).map(
                ([k, v]) => [k, formatValue(v)] as [string, string],
              ),
            ]}
          />
        </details>
      ) : null}
      <details>
        <summary>Evidence ({shown.evidence.length})</summary>
        <EvidenceList evidence={shown.evidence} />
      </details>
      <MissingEvidenceList missing={shown.missingEvidence} />
      {shown.review ? (
        <p className="caption">
          {shown.review.decision} by {shown.review.reviewer.actorLabel} at{' '}
          {formatDateTime(shown.review.reviewedAt)}
          {shown.review.reason ? `: ${shown.review.reason}` : ''}
        </p>
      ) : null}
      {applyUnknown ? (
        <div data-testid="apply-outcome-unknown">
          <StatusBadge tone="warning" label="Apply outcome: unknown" />
          <p>
            The owning module&apos;s records are being checked. Do not apply this again.
            {shown.apply.lastError ? ` (${shown.apply.lastError.code})` : ''}
          </p>
          {canSettle ? <SettleApplyForm recommendation={shown} /> : null}
        </div>
      ) : shown.apply.lastError ? (
        <p className="error-text">
          Not applied: {shown.apply.lastError.code}. {shown.apply.lastError.message}
        </p>
      ) : null}
      {shown.apply.record ? (
        <p>
          Applied to <RecordRef type={shown.apply.record.type} id={shown.apply.record.id} />
        </p>
      ) : null}
      {operation.data ? <p className="caption">Operation status: {operation.data.status}</p> : null}
      <SettlementList settlements={shown.apply.settlements} />
      {canReview ? (
        <>
          <TextAreaField
            label="Reason for rejecting"
            hint="Needed only to reject."
            value={reason}
            onChange={setReason}
            error={reasonError}
            maxLength={2000}
          />
          <div className="actions-row">
            {assistantOn === true ? (
              <Button
                busy={approve.isProcessing}
                disabled={!online || busy}
                aria-label={`Approve recommendation: ${shown.title}`}
                onClick={doApprove}
              >
                Approve
              </Button>
            ) : null}
            <Button
              variant="secondary"
              busy={reject.isProcessing}
              disabled={!online || busy}
              aria-label={`Reject recommendation: ${shown.title}`}
              onClick={doReject}
            >
              Reject
            </Button>
          </div>
        </>
      ) : null}
      {assistantOn === false && (canReview || shown.status === 'approved') ? (
        <p className="caption">
          Approving and applying are turned off while the assistant is turned off; rejecting stays
          available.
        </p>
      ) : null}
      {canApply ? (
        <div className="actions-row">
          <Button
            busy={apply.isProcessing}
            disabled={!online || busy}
            aria-label={`Apply recommendation: ${shown.title}`}
            onClick={doApply}
          >
            Apply
          </Button>
          <span className="caption">Runs {shown.command?.actionId} with your own permissions.</span>
        </div>
      ) : null}
      <CommandSuccess message={success} />
      <CommandError error={approve.error} onRetry={doApprove} onReload={reload} />
      <CommandError error={reject.error} onRetry={doReject} onReload={reload} />
      {applyUnknown ? null : (
        <CommandError error={apply.error} onRetry={doApply} onReload={reload} />
      )}
    </li>
  );
}

function AssistantAnswer({
  initial,
  assistantOn,
}: {
  initial: AssistantRequest;
  assistantOn: boolean | undefined;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const params = { path: { id: initial.id } };
  // The latest answer decides whether to keep polling; each answer re-renders this component.
  const cached = queryClient.getQueryData<ApiResponse<AssistantRequest>>(
    apiQueryKey('/assistant/requests/{id}', params),
  );
  const processing = (cached?.data ?? initial).status === 'processing';
  const request = useApiQuery({
    path: '/assistant/requests/{id}',
    request: params,
    enabled: processing,
    refetchInterval: processing ? ASSISTANT_POLL_MS : false,
  });
  const answer = request.data ?? initial;
  const statusTone: StatusTone =
    answer.status === 'answered' ? 'success' : answer.status === 'failed' ? 'danger' : 'pending';
  return (
    <section aria-label="Assistant answer" className="panel">
      <span className="actions-row">
        <StatusBadge tone={statusTone} label={`Answer: ${answer.status}`} />
      </span>
      <LastUpdated at={request.updatedAt} now={now} />
      {answer.status === 'processing' ? (
        <p role="progressbar" aria-busy="true" aria-label="Waiting for the assistant">
          Waiting for the assistant…
        </p>
      ) : null}
      {answer.response ? <p>{answer.response.text}</p> : null}
      {answer.error ? (
        <p className="error-text">
          {answer.error.code}. {answer.error.message}
        </p>
      ) : null}
      <h4>Supporting records</h4>
      <EvidenceList evidence={answer.evidence} />
      <MissingEvidenceList missing={answer.missingEvidence} />
      {answer.recommendations.length > 0 ? (
        <>
          <h4>Proposals for review</h4>
          <ul className="list" aria-label="Proposals from this answer">
            {answer.recommendations.map((r) => (
              <RecommendationCard key={r.id} recommendation={r} assistantOn={assistantOn} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function AskForm({
  facilityId,
  assistantOn,
}: {
  facilityId: string | null;
  assistantOn: boolean | undefined;
}) {
  const { online } = useApp();
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  const ask = useApiCommand('post', '/assistant/requests', { invalidate: [RECOMMENDATIONS_KEY] });
  const submit = () => {
    if (!prompt.trim()) {
      setPromptError('Write a question for the assistant.');
      return;
    }
    setPromptError(null);
    void ask
      .submit({
        body: {
          prompt: prompt.trim(),
          ...(facilityId ? { facilityId } : {}),
          attachments: [],
          context: [],
        },
      })
      .catch(() => undefined);
  };
  return (
    <>
      <form
        noValidate
        className="form"
        aria-label="Ask the assistant"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextAreaField
          label="Question"
          required
          hint="For example: summarize today's unresolved issues. The assistant reads only what you may read."
          value={prompt}
          onChange={setPrompt}
          error={promptError}
          maxLength={4000}
        />
        <Button type="submit" busy={ask.isProcessing} disabled={!online}>
          Ask
        </Button>
      </form>
      <CommandError error={ask.error} onRetry={submit} />
      {ask.data ? (
        <AssistantAnswer key={ask.data.id} initial={ask.data} assistantOn={assistantOn} />
      ) : null}
    </>
  );
}

/** "Assistant turned off" for the organization's switch, above what stays available. */
function AssistantSwitchedOff() {
  const presentation = CAPABILITY_PRESENTATION[ASSISTANT_CAPABILITY];
  return (
    <div data-testid="assistant-capability-off">
      <StateView
        variant="turned-off"
        subject={presentation.label}
        decisions={presentation.decisions}
        owner={presentation.owner}
        stillAvailable="Recommendations already proposed stay listed and can still be rejected; an apply whose outcome is unknown can still be reconciled."
      />
    </div>
  );
}

export function AssistantPanel({ facilityId }: { facilityId: string | null }) {
  const { online } = useApp();
  const permissions = usePermissions();
  const assistantOn = permissions.isCapabilityEnabled(ASSISTANT_CAPABILITY);
  // Read by status (the API filters), so newer applied or rejected ones never push the ones
  // still waiting out of the page; a page that has more says so (never a false "none").
  const proposed = useApiQuery({
    path: '/recommendations',
    request: { query: { status: 'proposed', limit: AWAITING_PAGE } },
    enabled: online,
  });
  const approved = useApiQuery({
    path: '/recommendations',
    request: { query: { status: 'approved', limit: AWAITING_PAGE } },
    enabled: online,
  });
  const pending = proposed.error ? proposed : approved.error ? approved : proposed;
  let body;
  if (!online) {
    body = (
      <StateView
        variant="unavailable"
        title="Needs a connection"
        description="The assistant is not available offline. The rest of Today keeps working."
      />
    );
  } else if (pending.error && isAssistantDisabled(pending.error)) {
    body = (
      <section className="state" data-testid="assistant-disabled">
        <StatusBadge tone="neutral" label="Assistant turned off" />
        <p>
          The assistant is turned off for this organization. Whether it is used is decided by the
          product owner (DEC-016). Everything on Today works without it.
        </p>
      </section>
    );
  } else if (pending.error) {
    body =
      pending.error.isNotFound || pending.error.isPermissionRestriction ? (
        <StateView variant="unavailable" title="Not available to you" />
      ) : (
        <StateView variant="error" error={pending.error} onRetry={() => void pending.refetch()} />
      );
  } else if (!proposed.data || !approved.data) {
    body = <StateView variant="loading" label="the assistant" />;
  } else {
    const open = [...proposed.data.items, ...approved.data.items];
    const more = proposed.data.nextCursor !== null || approved.data.nextCursor !== null;
    body = (
      <>
        {assistantOn === true ? (
          <AskForm facilityId={facilityId} assistantOn={assistantOn} />
        ) : assistantOn === false ? (
          <AssistantSwitchedOff />
        ) : (
          <StateView variant="loading" label="whether the assistant is turned on" />
        )}
        <h4>Awaiting review</h4>
        {open.length === 0 && !more ? (
          <p>No recommendations are waiting for review.</p>
        ) : (
          <ul className="list" aria-label="Recommendations awaiting review">
            {open.map((r) => (
              <RecommendationCard key={r.id} recommendation={r} assistantOn={assistantOn} />
            ))}
          </ul>
        )}
        {more ? (
          <p className="caption" data-testid="more-awaiting">
            More recommendations are waiting than are shown here ({AWAITING_PAGE} of each status).
          </p>
        ) : null}
      </>
    );
  }
  return (
    <section id="assistant-panel" className="panel" aria-labelledby="assistant-title">
      <h3 id="assistant-title">Operational assistant (optional)</h3>
      <p className="caption">
        Answers name their supporting records and how fresh they are. Nothing it proposes runs until
        a person approves and applies it.
      </p>
      {body}
    </section>
  );
}
