/**
 * SCR-S-18 Placement board (SPK-PLACE-001 approved placement information, SPK-PLACE-002 eligible
 * candidate teams with explainable reasons, staff-reviewed by default, SPK-PLACE-003 capacity and
 * eligibility checked at commitment and a recommendation reserves nothing, SPK-PLACE-005 no public
 * profiles, SPK-UX-008). Individual entrants waiting for a team are listed with the information
 * they gave; candidates come from the API with their reasons and the capacity they would use.
 * Propose, assign, reject a proposal and release carry `expectedRevision`. CAPACITY_UNAVAILABLE or
 * a changed eligibility at assignment is shown with its code, and the candidates are reloaded.
 * The assignment's operation is shown: `recovery_required` means a follow-up (roster addition or
 * notice) was not recorded. The placement model and its fields are pending DEC-031 and DEC-051.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, ReasonList } from '../../features/competition/CommandError';
import {
  keys,
  PageButtons,
  PendingNote,
  SuccessNote,
  useCursorStack,
  useRefetch,
} from '../../features/competition/feedback';
import { SelectField, TextAreaField } from '../../features/competition/fields';
import { formatInstant } from '../../features/competition/format';
import { PLACEMENT_STATUS, weekdayName } from '../../features/competition/labels';
import { SeasonLinks, TeamsNav } from '../../features/competition/nav';
import { EntryName, PersonName, useSeasonEntries } from '../../features/competition/names';
import { OperationStatus } from '../../features/competition/OperationStatus';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type PlacementRequest = Schema<'PlacementRequest'>;
type PlacementStatus = Schema<'PlacementStatus'>;

const PLACEMENT_KEYS = keys(
  '/placement-requests',
  '/placement-requests/{id}',
  '/placement-requests/{id}/candidates',
  '/team-entries',
);

function PlacementInformation({ request }: { request: PlacementRequest }) {
  return (
    <dl className="facets" aria-label="Placement information">
      <div>
        <dt>Availability</dt>
        <dd>
          {request.availability.length === 0
            ? 'Not given'
            : request.availability
                .map((w) => `${weekdayName(w.weekday)} ${w.from} to ${w.to}`)
                .join(', ')}
        </dd>
      </div>
      <div>
        <dt>Declared level</dt>
        <dd>{request.declaredLevel ?? 'Not given'}</dd>
      </div>
      <div>
        <dt>Positions</dt>
        <dd>
          {request.positionPreferences.length > 0
            ? request.positionPreferences.join(', ')
            : 'Not given'}
        </dd>
      </div>
      <div>
        <dt>Requested teammates</dt>
        <dd>{request.requestedTeammatePersonIds.length}</dd>
      </div>
      {request.notes ? (
        <div>
          <dt>Notes</dt>
          <dd>{request.notes}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function Candidates({ request }: { request: PlacementRequest }) {
  const candidates = useApiQuery({
    path: '/placement-requests/{id}/candidates',
    request: { path: { id: request.id } },
  });
  const propose = useApiCommand('post', '/placement-requests/{id}/propose', {
    invalidate: PLACEMENT_KEYS,
  });
  const assign = useApiCommand('post', '/placement-requests/{id}/assign', {
    invalidate: PLACEMENT_KEYS,
  });
  const reload = useRefetch(['/placement-requests', '/placement-requests/{id}/candidates']);
  const [last, setLast] = useState<{ kind: 'propose' | 'assign'; teamEntryId: string } | null>(
    null,
  );
  const send = (kind: 'propose' | 'assign', teamEntryId: string) => {
    setLast({ kind, teamEntryId });
    const options = {
      path: { id: request.id },
      body: { teamEntryId, expectedRevision: request.revision },
    };
    const sent = kind === 'propose' ? propose.submit(options) : assign.submit(options);
    void sent.catch(() => undefined);
  };
  const error = propose.error ?? assign.error;
  return (
    <section aria-labelledby={`candidates-${request.id}`}>
      <h4 id={`candidates-${request.id}`}>Candidate teams</h4>
      <p className="caption">
        A recommendation reserves nothing: capacity and eligibility are checked again when you
        assign.
      </p>
      <QueryBoundary
        query={candidates}
        label="candidate teams"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No candidate teams',
          description: 'No approved team of this season can take this entrant now.',
        }}
        unavailableOffline={['proposing and assigning placements']}
      >
        {(data) => (
          <ul className="list" aria-label="Candidate teams">
            {data.map((candidate) => (
              <li
                key={candidate.teamEntryId}
                aria-labelledby={`cand-${request.id}-${candidate.teamEntryId}`}
              >
                <div className="row-text">
                  <span className="row-title" id={`cand-${request.id}-${candidate.teamEntryId}`}>
                    {candidate.teamName}
                  </span>
                  <span>
                    <StatusBadge
                      tone={candidate.eligible ? 'success' : 'danger'}
                      label={candidate.eligible ? 'Eligible' : 'Not eligible'}
                    />{' '}
                    {candidate.recommended ? <StatusBadge tone="info" label="Recommended" /> : null}
                  </span>
                  <span className="caption">
                    {candidate.capacity
                      ? `${candidate.capacity.available} of ${candidate.capacity.capacity} roster places free`
                      : 'No roster capacity limit recorded'}
                    {` · ${candidate.requestedTeammatesOnRoster} requested teammate(s) on this roster`}
                  </span>
                  <ReasonList
                    reasons={candidate.reasons}
                    label={`Reasons for ${candidate.teamName}`}
                  />
                </div>
                <div className="actions">
                  {request.status === 'unassigned' ? (
                    <CommandButton
                      variant="secondary"
                      busy={propose.isProcessing && last?.teamEntryId === candidate.teamEntryId}
                      aria-label={`Propose ${candidate.teamName}`}
                      onClick={() => send('propose', candidate.teamEntryId)}
                    >
                      Propose
                    </CommandButton>
                  ) : null}
                  <CommandButton
                    busy={assign.isProcessing && last?.teamEntryId === candidate.teamEntryId}
                    aria-label={`Assign to ${candidate.teamName}`}
                    onClick={() => send('assign', candidate.teamEntryId)}
                  >
                    Assign
                  </CommandButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      {propose.status === 'success' && propose.data ? (
        <SuccessNote>{`Placement ${propose.data.status}`}</SuccessNote>
      ) : null}
      {assign.status === 'success' && assign.data ? (
        <>
          <SuccessNote>{`Placement ${assign.data.status}`}</SuccessNote>
          <OperationStatus operationId={assign.data.lastOperationId} />
        </>
      ) : null}
      <CommandError
        error={error}
        onRetry={() => (last ? send(last.kind, last.teamEntryId) : undefined)}
        onReload={() => {
          propose.reset();
          assign.reset();
          reload();
        }}
      />
    </section>
  );
}

function ReasonedAction({
  request,
  kind,
}: {
  request: PlacementRequest;
  kind: 'reject-proposal' | 'release';
}) {
  const reject = useApiCommand('post', '/placement-requests/{id}/reject-proposal', {
    invalidate: PLACEMENT_KEYS,
  });
  const release = useApiCommand('post', '/placement-requests/{id}/release', {
    invalidate: PLACEMENT_KEYS,
  });
  const command = kind === 'release' ? release : reject;
  const reload = useRefetch(['/placement-requests']);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const label = kind === 'release' ? 'Release the placement' : 'Reject the proposal';
  const submit = () => {
    if (!reason.trim()) {
      setError('Give a reason.');
      return;
    }
    setError(null);
    const body = { reason: reason.trim(), expectedRevision: request.revision };
    const sent =
      kind === 'release'
        ? release.submit({ path: { id: request.id }, body })
        : reject.submit({ path: { id: request.id }, body });
    void sent.catch(() => undefined);
  };
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField label="Reason" required value={reason} onChange={setReason} error={error} />
      <CommandButton type="submit" variant="secondary" busy={command.isProcessing}>
        {label}
      </CommandButton>
      {command.status === 'success' && command.data ? (
        <SuccessNote>{`Placement ${command.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={command.error}
        onRetry={submit}
        onReload={() => {
          command.reset();
          reload();
        }}
      />
    </form>
  );
}

function RequestCard({
  request,
  entries,
}: {
  request: PlacementRequest;
  entries: ReadonlyMap<string, { teamId: string }>;
}) {
  const [showCandidates, setShowCandidates] = useState(false);
  const badge = PLACEMENT_STATUS[request.status];
  return (
    <li aria-labelledby={`placement-${request.id}`}>
      <div className="row-text">
        <span className="row-title" id={`placement-${request.id}`}>
          <PersonName personId={request.participantPersonId} />
        </span>
        <StatusBadge tone={badge.tone} label={`Placement ${badge.label}`} />
        <span className="caption">Requested {formatInstant(request.createdAt)}</span>
        <PlacementInformation request={request} />
        {request.proposedTeamEntryId ? (
          <span>
            Proposed: <EntryName entryId={request.proposedTeamEntryId} teamIdOf={entries} />
            {request.proposedAt ? ` (${formatInstant(request.proposedAt)})` : ''}
          </span>
        ) : null}
        {request.proposalReasons.length > 0 ? (
          <ReasonList reasons={request.proposalReasons} label="Proposal reasons" />
        ) : null}
        {request.assignedTeamEntryId ? (
          <span>
            Assigned: <EntryName entryId={request.assignedTeamEntryId} teamIdOf={entries} />
            {request.assignedAt ? ` (${formatInstant(request.assignedAt)})` : ''}
          </span>
        ) : null}
        {request.releaseReason ? <span>Released: {request.releaseReason}</span> : null}
        {request.status === 'assigned' ? (
          <OperationStatus operationId={request.lastOperationId} />
        ) : null}
      </div>
      <div className="actions">
        {request.status === 'unassigned' || request.status === 'proposed' ? (
          <Button
            variant="secondary"
            aria-expanded={showCandidates}
            onClick={() => setShowCandidates((s) => !s)}
          >
            {showCandidates ? 'Hide candidate teams' : 'Show candidate teams'}
          </Button>
        ) : null}
        {request.status === 'proposed' ? (
          <ReasonedAction request={request} kind="reject-proposal" />
        ) : null}
        {request.status === 'assigned' ? <ReasonedAction request={request} kind="release" /> : null}
      </div>
      {showCandidates ? <Candidates request={request} /> : null}
    </li>
  );
}

export function PlacementBoardScreen() {
  const { seasonId = '' } = useParams();
  const [status, setStatus] = useState<PlacementStatus | ''>('unassigned');
  const { byId } = useSeasonEntries(seasonId);
  // Every entrant is reachable: pages follow the API cursor (SPK-PLACE-001, §4.5).
  const pages = useCursorStack();
  const requests = useApiQuery({
    path: '/placement-requests',
    request: {
      query: {
        seasonId,
        limit: 50,
        ...(status ? { status } : {}),
        ...(pages.cursor ? { cursor: pages.cursor } : {}),
      },
    },
  });
  return (
    <section aria-labelledby="placement-title">
      <h2 id="placement-title">Placement board</h2>
      <TeamsNav />
      <SeasonLinks seasonId={seasonId} />
      <PendingNote decision={PENDING.placementModel} />
      <SelectField
        label="Placement state"
        value={status}
        onChange={(v) => {
          setStatus(v as PlacementStatus | '');
          pages.reset();
        }}
        options={Object.entries(PLACEMENT_STATUS).map(([value, b]) => ({ value, label: b.label }))}
        placeholder="All states"
      />
      <QueryBoundary
        query={requests}
        label="placement requests"
        isEmpty={(data) => data.items.length === 0 && pages.depth === 0}
        empty={{
          title: status === 'unassigned' ? 'No unplaced entrants' : 'No placement requests',
          description:
            'Individual entrants who asked to be placed on a team appear here with the information they gave.',
        }}
        unavailableOffline={['proposing, assigning and releasing placements']}
      >
        {(data) => (
          <>
            <ul className="list" aria-label="Placement requests">
              {data.items.map((request) => (
                <RequestCard key={request.id} request={request} entries={byId} />
              ))}
            </ul>
            <PageButtons
              what="placement requests"
              depth={pages.depth}
              nextCursor={data.nextCursor}
              onNext={pages.next}
              onPrevious={pages.previous}
            />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
