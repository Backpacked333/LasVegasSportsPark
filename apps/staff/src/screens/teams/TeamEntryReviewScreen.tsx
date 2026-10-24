/**
 * SCR-S-16 Team entry review (SPK-COMP-004 approval, financial status, roster completion and
 * competition eligibility kept distinct, with what is missing and who can resolve it;
 * SPK-REG-007, SPK-CAP-005, SPK-AT-003, SPK-UX-008). The four facets are shown side by side and
 * never merged: "approved" never means paid or roster-complete. Approve (optionally placing the
 * entry in a division) and decline need `expectedRevision`; a decline needs a reason, checked here
 * before sending (validation failure) and again by the API. The finance module sets the financial
 * reference; the dashboard shows it and never infers a payment state from it.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, ReasonList } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import { SelectField, TextAreaField } from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import { ENTRY_ELIGIBILITY, TEAM_ENTRY_STATUS } from '../../features/competition/labels';
import { SeasonLinks, TeamsNav } from '../../features/competition/nav';
import { TeamName } from '../../features/competition/names';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type TeamEntry = Schema<'TeamEntry'>;
type Division = Schema<'Division'>;
type EntryStatus = Schema<'TeamEntryStatus'>;

const ENTRY_KEYS = keys('/team-entries', '/team-entries/{id}', '/divisions');

function EntryActions({ entry, divisions }: { entry: TeamEntry; divisions: readonly Division[] }) {
  const approve = useApiCommand('post', '/team-entries/{id}/approve', { invalidate: ENTRY_KEYS });
  const reject = useApiCommand('post', '/team-entries/{id}/reject', { invalidate: ENTRY_KEYS });
  const withdraw = useApiCommand('post', '/team-entries/{id}/withdraw', { invalidate: ENTRY_KEYS });
  const reload = useRefetch(['/team-entries']);
  const [mode, setMode] = useState<'approve' | 'reject' | 'withdraw' | null>(null);
  const [divisionId, setDivisionId] = useState(entry.divisionId ?? '');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const doApprove = () =>
    void approve
      .submit({
        path: { id: entry.id },
        body: {
          expectedRevision: entry.revision,
          ...(divisionId ? { divisionId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      })
      .catch(() => undefined);
  const doReasoned = (kind: 'reject' | 'withdraw') => {
    if (!reason.trim()) {
      setError(
        kind === 'reject' ? 'A decline needs a reason the captain will see.' : 'Give a reason.',
      );
      return;
    }
    setError(null);
    const options = {
      path: { id: entry.id },
      body: { expectedRevision: entry.revision, reason: reason.trim() },
    };
    const sent = kind === 'reject' ? reject.submit(options) : withdraw.submit(options);
    void sent.catch(() => undefined);
  };
  const onReload = () => {
    approve.reset();
    reject.reset();
    withdraw.reset();
    reload();
  };
  const success = approve.data ?? reject.data ?? withdraw.data;

  if (entry.status === 'rejected' || entry.status === 'withdrawn') return null;
  return (
    <div className="form">
      <div className="actions">
        {entry.status === 'applied' ? (
          <>
            <Button variant="secondary" onClick={() => setMode('approve')}>
              Approve
            </Button>
            <Button variant="secondary" onClick={() => setMode('reject')}>
              Decline
            </Button>
          </>
        ) : null}
        <Button variant="secondary" onClick={() => setMode('withdraw')}>
          Withdraw
        </Button>
      </div>
      {mode === 'approve' ? (
        <form
          className="form"
          noValidate
          aria-label="Approve the entry"
          onSubmit={(event) => {
            event.preventDefault();
            doApprove();
          }}
        >
          <SelectField
            label="Place in division"
            value={divisionId}
            onChange={setDivisionId}
            options={divisions.map((d) => ({
              value: d.id,
              label:
                d.capacityTeamEntries !== null
                  ? `${d.name} (${d.entryCount} of ${d.capacityTeamEntries} places used)`
                  : d.name,
            }))}
            placeholder="Do not place yet"
            hint="Division capacity is checked when the entry is placed."
          />
          <TextAreaField label="Approval note" value={note} onChange={setNote} />
          <CommandButton type="submit" busy={approve.isProcessing}>
            Approve the entry
          </CommandButton>
        </form>
      ) : null}
      {mode === 'reject' || mode === 'withdraw' ? (
        <form
          className="form"
          noValidate
          aria-label={mode === 'reject' ? 'Decline the entry' : 'Withdraw the entry'}
          onSubmit={(event) => {
            event.preventDefault();
            doReasoned(mode === 'reject' ? 'reject' : 'withdraw');
          }}
        >
          <TextAreaField
            label="Reason"
            required
            value={reason}
            onChange={setReason}
            error={error}
          />
          <CommandButton
            type="submit"
            variant="secondary"
            busy={mode === 'reject' ? reject.isProcessing : withdraw.isProcessing}
          >
            {mode === 'reject' ? 'Decline the entry' : 'Withdraw the entry'}
          </CommandButton>
        </form>
      ) : null}
      {success ? <SuccessNote>{`Entry ${success.status}`}</SuccessNote> : null}
      <CommandError
        error={approve.error ?? reject.error ?? withdraw.error}
        onRetry={() =>
          mode === 'approve' ? doApprove() : doReasoned(mode === 'reject' ? 'reject' : 'withdraw')
        }
        onReload={onReload}
      />
    </div>
  );
}

function EntryRow({ entry, divisions }: { entry: TeamEntry; divisions: readonly Division[] }) {
  const approval = TEAM_ENTRY_STATUS[entry.status];
  const eligibility = ENTRY_ELIGIBILITY[entry.eligibilityStatus];
  const division = divisions.find((d) => d.id === entry.divisionId);
  const missingPlayers = Math.max(0, entry.rosterMin - entry.rosterCount);
  return (
    <li aria-labelledby={`entry-${entry.id}`}>
      <div className="row-text">
        <span className="row-title" id={`entry-${entry.id}`}>
          <TeamName teamId={entry.teamId} />
        </span>
        <span className="caption">
          Applied {formatInstant(entry.appliedAt)} ·{' '}
          {division ? `Division ${division.name}` : 'Not placed in a division'}
          {entry.renewedFromEntryId
            ? ` · renewal of entry ${shortRef(entry.renewedFromEntryId)}`
            : ''}
        </span>
        <dl className="facets" aria-label="Entry facets">
          <div>
            <dt>Approval</dt>
            <dd>
              <StatusBadge tone={approval.tone} label={`Entry ${approval.label}`} />
            </dd>
          </div>
          <div>
            <dt>Financial status</dt>
            <dd>
              {entry.financialStatusRef ? (
                <StatusBadge
                  tone="info"
                  label={`Obligation ${shortRef(entry.financialStatusRef)}`}
                />
              ) : (
                <StatusBadge tone="pending" label="No obligation recorded by finance yet" />
              )}
            </dd>
          </div>
          <div>
            <dt>Roster completion</dt>
            <dd>
              <StatusBadge
                tone={entry.rosterComplete ? 'success' : 'warning'}
                label={entry.rosterComplete ? 'Roster complete' : 'Roster incomplete'}
              />{' '}
              <span className="caption">
                {entry.rosterCount} players (rule set {entry.rosterMin} to {entry.rosterMax})
              </span>
            </dd>
          </div>
          <div>
            <dt>Competition eligibility</dt>
            <dd>
              <StatusBadge tone={eligibility.tone} label={eligibility.label} />
            </dd>
          </div>
        </dl>
        {!entry.rosterComplete && missingPlayers > 0 ? (
          <span>
            Missing: {missingPlayers} more {missingPlayers === 1 ? 'player' : 'players'}. Resolved
            by the team&apos;s captain, or league administration on the roster.
          </span>
        ) : null}
        {entry.rosterCount > entry.rosterMax ? (
          <span>Over the roster maximum by {entry.rosterCount - entry.rosterMax}.</span>
        ) : null}
        <ReasonList reasons={entry.eligibilityReasons} label="What is missing" />
        {entry.rejectionReason ? <span>Declined: {entry.rejectionReason}</span> : null}
        {entry.withdrawalReason ? <span>Withdrawn: {entry.withdrawalReason}</span> : null}
        <Link to={`/teams/entries/${entry.id}/roster`}>Roster</Link>
      </div>
      <EntryActions entry={entry} divisions={divisions} />
    </li>
  );
}

export function TeamEntryReviewScreen() {
  const { seasonId = '' } = useParams();
  const [status, setStatus] = useState('');
  const [divisionId, setDivisionId] = useState('');
  const divisions = useApiQuery({ path: '/divisions', request: { query: { seasonId } } });
  const entries = useApiQuery({
    path: '/team-entries',
    request: {
      query: {
        seasonId,
        ...(status ? { status: status as EntryStatus } : {}),
        ...(divisionId ? { divisionId } : {}),
      },
    },
  });
  return (
    <section aria-labelledby="entries-title">
      <h2 id="entries-title">Team entries</h2>
      <TeamsNav />
      <SeasonLinks seasonId={seasonId} />
      <div className="actions">
        <SelectField
          label="Approval"
          value={status}
          onChange={setStatus}
          options={Object.entries(TEAM_ENTRY_STATUS).map(([value, b]) => ({
            value,
            label: b.label,
          }))}
          placeholder="All"
        />
        <SelectField
          label="Division"
          value={divisionId}
          onChange={setDivisionId}
          options={(divisions.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          placeholder="All divisions"
        />
      </div>
      <QueryBoundary
        query={entries}
        label="team entries"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No entries',
          description:
            'Team entries for this season appear here when captains apply or staff enter a team.',
        }}
        unavailableOffline={['approving, declining or withdrawing entries']}
      >
        {(data) => (
          <ul className="list" aria-label="Team entries">
            {data.map((entry) => (
              <EntryRow key={entry.id} entry={entry} divisions={divisions.data ?? []} />
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
