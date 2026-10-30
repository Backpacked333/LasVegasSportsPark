/**
 * SCR-S-12 Disputes and discipline, restricted decision and appeal lists (CMP-05:
 * `GET /v1/disciplinary-decisions`, `GET /v1/appeals`; SPK-DISC-003 decisions with history and
 * overturn, SPK-DISC-005 appeals, SPK-UX-008). Both lists page with the API's cursor ("Load
 * more", nothing silently cut off) and need league management authority: anyone else sees "not
 * available" and nothing implies a record exists. Overturning a decision needs a reason and
 * `expectedRevision`; an appeal moves only along the appeal machine (review, grant, deny,
 * withdraw), and granting or denying needs a reason. The appeal procedure is pending DEC-010, so
 * no outcome is preselected and the API decides who may act.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import { SelectField, TextAreaField } from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import {
  APPEAL_STATUS,
  DECISION_KIND,
  DECISION_STATUS,
  humanizeCode,
} from '../../features/competition/labels';
import { PersonName, usePersonNames } from '../../features/competition/names';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type Decision = Schema<'DisciplinaryDecision'>;
type DecisionStatus = Schema<'DisciplinaryDecisionStatus'>;
type Appeal = Schema<'Appeal'>;
type AppealStatus = Schema<'AppealStatus'>;
type AppealAction = 'review' | 'grant' | 'deny' | 'withdraw';

const PAGE_SIZE = 25;

function OverturnDecision({ decision }: { decision: Decision }) {
  const overturn = useApiCommand('post', '/disciplinary-decisions/{id}/overturn', {
    invalidate: keys('/disciplinary-decisions', '/disciplinary-decisions/{id}', '/suspensions'),
  });
  const reload = useRefetch(['/disciplinary-decisions']);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!reason.trim()) {
      setError('Overturning a decision needs a reason.');
      return;
    }
    setError(null);
    void overturn
      .submit({
        path: { id: decision.id },
        body: { expectedRevision: decision.revision, reason: reason.trim() },
      })
      .catch(() => undefined);
  };
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Overturn the decision
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label="Overturn the decision"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField
        label="Reason for overturning"
        required
        value={reason}
        onChange={setReason}
        error={error}
      />
      <div className="actions">
        <CommandButton type="submit" variant="secondary" busy={overturn.isProcessing}>
          Overturn
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep the decision
        </Button>
      </div>
      {overturn.status === 'success' && overturn.data ? (
        <SuccessNote>{`Decision ${overturn.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={overturn.error}
        onRetry={submit}
        onReload={() => {
          overturn.reset();
          reload();
        }}
      />
    </form>
  );
}

export function Decisions() {
  const [status, setStatus] = useState<DecisionStatus | ''>('');
  const [competitionId, setCompetitionId] = useState('');
  const competitions = useApiQuery({ path: '/competitions', staleTime: 5 * 60_000 });
  const decisions = useApiPages({
    path: '/disciplinary-decisions',
    request: {
      query: {
        limit: PAGE_SIZE,
        ...(status ? { status } : {}),
        ...(competitionId ? { competitionId } : {}),
      },
    },
  });
  const names = usePersonNames((decisions.data ?? []).map((d) => d.subjectPersonId));
  return (
    <section className="panel" aria-labelledby="decisions-title">
      <h3 id="decisions-title">Disciplinary decisions</h3>
      <div className="actions">
        <SelectField
          label="Decision status"
          value={status}
          onChange={(v) => setStatus(v as DecisionStatus | '')}
          options={Object.entries(DECISION_STATUS).map(([value, b]) => ({
            value,
            label: b.label,
          }))}
          placeholder="All statuses"
        />
        <SelectField
          label="Competition"
          value={competitionId}
          onChange={setCompetitionId}
          options={(competitions.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          placeholder="Every competition"
        />
      </div>
      <QueryBoundary
        query={decisions}
        label="disciplinary decisions"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No disciplinary decisions',
          description: 'Decisions issued under the approved rule set appear here, newest first.',
        }}
        unavailableOffline={['overturning decisions']}
      >
        {(items) => (
          <ul className="list" aria-label="Disciplinary decisions">
            {items.map((decision) => {
              const badge = DECISION_STATUS[decision.status];
              return (
                <li key={decision.id} aria-labelledby={`decision-${decision.id}`}>
                  <div className="row-text">
                    <span className="row-title" id={`decision-${decision.id}`}>
                      <PersonName personId={decision.subjectPersonId} names={names} />:{' '}
                      {DECISION_KIND[decision.decision]}
                    </span>
                    <StatusBadge tone={badge.tone} label={`Decision ${badge.label}`} />
                    <dl className="facets">
                      <div>
                        <dt>Basis</dt>
                        <dd>{decision.basis}</dd>
                      </div>
                      <div>
                        <dt>Decided by</dt>
                        <dd>
                          {decision.decidedBy.actorLabel} {formatInstant(decision.decidedAt)}
                        </dd>
                      </div>
                      <div>
                        <dt>Rule set</dt>
                        <dd>{decision.ruleSetId ? shortRef(decision.ruleSetId) : 'Not named'}</dd>
                      </div>
                      <div>
                        <dt>Suspension</dt>
                        <dd>
                          {decision.suspensionId
                            ? `Suspension ${shortRef(decision.suspensionId)}`
                            : 'None'}
                        </dd>
                      </div>
                    </dl>
                    {decision.overturnReason ? (
                      <span>
                        Overturned {formatInstant(decision.overturnedAt)}: {decision.overturnReason}
                      </span>
                    ) : null}
                  </div>
                  {decision.status === 'issued' ? <OverturnDecision decision={decision} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={decisions} label="decisions" />
    </section>
  );
}

/** AppealMachine moves from each state (§4.6); the API refuses any other. */
const APPEAL_ACTIONS: Record<AppealStatus, readonly AppealAction[]> = {
  submitted: ['review', 'grant', 'deny', 'withdraw'],
  under_review: ['grant', 'deny', 'withdraw'],
  granted: [],
  denied: [],
  withdrawn: [],
};

const APPEAL_ACTION_LABEL: Record<AppealAction, string> = {
  review: 'Start review',
  grant: 'Grant',
  deny: 'Deny',
  withdraw: 'Record withdrawal',
};

function AppealActions({ appeal }: { appeal: Appeal }) {
  const decide = useApiCommand('post', '/appeals/{id}/decide', {
    invalidate: keys('/appeals', '/appeals/{id}', '/suspensions', '/disciplinary-decisions'),
  });
  const reload = useRefetch(['/appeals']);
  const [action, setAction] = useState<AppealAction | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<AppealAction | null>(null);
  const actions = APPEAL_ACTIONS[appeal.status];
  if (actions.length === 0) return null;
  const send = (chosen: AppealAction) => {
    setLast(chosen);
    const needsReason = chosen === 'grant' || chosen === 'deny';
    if (needsReason && !reason.trim()) {
      setError('Granting or denying an appeal needs a reason.');
      return;
    }
    setError(null);
    void decide
      .submit({
        path: { id: appeal.id },
        body: {
          action: chosen,
          expectedRevision: appeal.revision,
          ...(chosen !== 'review' && reason.trim() ? { reason: reason.trim() } : {}),
        },
      })
      .catch(() => undefined);
  };
  return (
    <div className="form">
      <div
        className="actions"
        role="group"
        aria-label={`Actions for appeal ${shortRef(appeal.id)}`}
      >
        {actions.map((a) =>
          a === 'review' ? (
            <CommandButton
              key={a}
              variant="secondary"
              busy={decide.isProcessing && last === 'review'}
              onClick={() => send('review')}
            >
              {APPEAL_ACTION_LABEL[a]}
            </CommandButton>
          ) : (
            <Button
              key={a}
              variant="secondary"
              aria-pressed={action === a}
              onClick={() => setAction(a)}
            >
              {APPEAL_ACTION_LABEL[a]}
            </Button>
          ),
        )}
      </div>
      {action && action !== 'review' ? (
        <form
          className="form"
          noValidate
          aria-label={`${APPEAL_ACTION_LABEL[action]} the appeal`}
          onSubmit={(event) => {
            event.preventDefault();
            send(action);
          }}
        >
          <TextAreaField
            label={action === 'withdraw' ? 'Note' : 'Reason'}
            required={action !== 'withdraw'}
            value={reason}
            onChange={setReason}
            error={error}
          />
          <CommandButton type="submit" busy={decide.isProcessing}>
            {`Confirm: ${APPEAL_ACTION_LABEL[action].toLowerCase()}`}
          </CommandButton>
        </form>
      ) : null}
      {decide.status === 'success' && decide.data ? (
        <SuccessNote>{`Appeal ${decide.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={decide.error}
        onRetry={() => (last ? send(last) : undefined)}
        onReload={() => {
          decide.reset();
          reload();
        }}
      />
    </div>
  );
}

function appealSubject(appeal: Appeal): string {
  if (appeal.decisionId) return `Decision ${shortRef(appeal.decisionId)}`;
  if (appeal.suspensionId) return `Suspension ${shortRef(appeal.suspensionId)}`;
  if (appeal.disputeId) return `Dispute ${shortRef(appeal.disputeId)}`;
  return 'Not stated';
}

export function Appeals() {
  // Every status by default: an open appeal is `submitted` or `under_review`.
  const [status, setStatus] = useState<AppealStatus | ''>('');
  const appeals = useApiPages({
    path: '/appeals',
    request: { query: { limit: PAGE_SIZE, ...(status ? { status } : {}) } },
  });
  const names = usePersonNames((appeals.data ?? []).map((a) => a.subjectPersonId));
  return (
    <section className="panel" aria-labelledby="appeals-title">
      <h3 id="appeals-title">Appeals</h3>
      <SelectField
        label="Appeal status"
        value={status}
        onChange={(v) => setStatus(v as AppealStatus | '')}
        options={Object.entries(APPEAL_STATUS).map(([value, b]) => ({ value, label: b.label }))}
        placeholder="All statuses"
      />
      <QueryBoundary
        query={appeals}
        label="appeals"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No appeals',
          description:
            'Appeals of decisions, suspensions and disputes appear here for review, newest first.',
        }}
        unavailableOffline={['reviewing and deciding appeals']}
      >
        {(items) => (
          <ul className="list" aria-label="Appeals">
            {items.map((appeal) => {
              const badge = APPEAL_STATUS[appeal.status];
              return (
                <li key={appeal.id} aria-labelledby={`appeal-${appeal.id}`}>
                  <div className="row-text">
                    <span className="row-title" id={`appeal-${appeal.id}`}>
                      Appeal for <PersonName personId={appeal.subjectPersonId} names={names} />
                    </span>
                    <StatusBadge tone={badge.tone} label={`Appeal ${badge.label}`} />
                    <dl className="facets">
                      <div>
                        <dt>Appeals</dt>
                        <dd>{appealSubject(appeal)}</dd>
                      </div>
                      <div>
                        <dt>Submitted by</dt>
                        <dd>
                          {appeal.submittedBy.actorLabel} {formatInstant(appeal.submittedAt)}
                        </dd>
                      </div>
                      <div>
                        <dt>Reviewer</dt>
                        <dd>{appeal.reviewer?.actorLabel ?? 'Not assigned yet'}</dd>
                      </div>
                      <div>
                        <dt>Decided</dt>
                        <dd>
                          {appeal.decidedAt ? formatInstant(appeal.decidedAt) : 'Not decided'}
                        </dd>
                      </div>
                    </dl>
                    <span>Grounds: {appeal.grounds}</span>
                    {appeal.decisionReason ? (
                      <span>Decision reason: {appeal.decisionReason}</span>
                    ) : null}
                    {appeal.evidence.length > 0 ? (
                      <ul aria-label="Evidence references">
                        {appeal.evidence.map((e, index) => (
                          <li key={index}>
                            {humanizeCode(e.kind)}: {e.reference}
                            {e.description ? ` (${e.description})` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="caption">No evidence references.</span>
                    )}
                  </div>
                  <AppealActions appeal={appeal} />
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={appeals} label="appeals" />
    </section>
  );
}
