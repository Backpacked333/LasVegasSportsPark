/**
 * SCR-S-18 Placement board (SPK-PLACE-001 approved placement information, SPK-PLACE-002 eligible
 * candidate teams with explainable reasons, staff-reviewed by default, SPK-PLACE-003 capacity and
 * eligibility checked at commitment and a recommendation reserves nothing, SPK-PLACE-005 no public
 * profiles, SPK-UX-008, SPK-UX-009). Individual entrants waiting for a team are listed with the
 * information they gave; the season's approved teams stand beside them as columns, each with its
 * roster size against the rule set's minimum and maximum (`TeamEntry.rosterCount`, `rosterMin`,
 * `rosterMax`).
 *
 * Placing is select-then-place, never drag only (SPK-UX-009): "Show candidate teams" selects an
 * entrant; the team columns then become the API's candidates for that entrant
 * (`GET /v1/placement-requests/{id}/candidates`) with their reasons and the capacity they would
 * use, and each candidate column offers "Propose" and "Assign" as ordinary buttons. A team the API
 * did not offer says so and offers nothing. Propose, assign, reject a proposal and release carry
 * `expectedRevision`. CAPACITY_UNAVAILABLE or a changed eligibility at assignment is shown with its
 * code, and the candidates are reloaded. The assignment's operation is shown: `recovery_required`
 * means a follow-up (roster addition or notice) was not recorded. The placement model and its
 * fields are pending DEC-031 and DEC-051.
 *
 * Keeper and skill balance come from staff player profiles (`GET /v1/seasons/{id}/player-profiles`,
 * staff-only, SPK-PLACE-005): each team column shows its goalkeepers and skill average over the
 * rated players on its roster now, each entrant their staff position and rating (recorded here,
 * PlayerProfile.tsx). A friend request is the teammates the entrant asked for on the placement
 * request; the candidates read says how many of them are on each candidate roster.
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
import { SeasonLinks } from '../../features/competition/nav';
import {
  EntryName,
  PersonName,
  usePersonNames,
  useSeasonEntries,
  type EntryNames,
  type PersonNames,
} from '../../features/competition/names';
import { OperationStatus } from '../../features/competition/OperationStatus';
import { CompeteHeader, initials } from '../../features/competition/page';
import { PENDING } from '../../features/competition/pending';
import { SeasonEyebrow } from '../../features/competition/season-context';
import { Button } from '../../ui/Button';
import { BalanceBadges, ProfileEditor, usePlayerProfiles } from './PlayerProfile';
import './teams.css';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';

type PlacementRequest = Schema<'PlacementRequest'>;
type PlacementStatus = Schema<'PlacementStatus'>;
type PlacementCandidate = Schema<'PlacementCandidate'>;
type TeamEntry = Schema<'TeamEntry'>;
type SeasonPlayerProfiles = Schema<'SeasonPlayerProfiles'>;

const PLACEMENT_KEYS = keys(
  '/placement-requests',
  '/placement-requests/{id}',
  '/placement-requests/{id}/candidates',
  '/team-entries',
  '/seasons/{id}/player-profiles',
);

/** A team colour band for each column, by position only (no meaning: the name is the label). */
const TEAM_BANDS = ['#c0392b', '#2d5bd8', '#b07a12', '#0e7c74', '#5b3fa8', '#b0306b', '#c4541c'];

function PlacementInformation({
  request,
  names,
}: {
  request: PlacementRequest;
  names: PersonNames;
}) {
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
        <dd>
          {request.requestedTeammatePersonIds.length === 0
            ? 'None'
            : request.requestedTeammatePersonIds.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ', ' : ''}
                  <PersonName personId={id} names={names} />
                </span>
              ))}
        </dd>
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

/** Roster size against the rule set's limits for one team entry, in words (SPK-UX-009). */
export function rosterCheck(entry: Pick<TeamEntry, 'rosterCount' | 'rosterMin' | 'rosterMax'>): {
  tone: StatusTone;
  label: string;
} {
  const { rosterCount: n, rosterMin: min, rosterMax: max } = entry;
  const players = `${n} ${n === 1 ? 'player' : 'players'}`;
  if (n > max) return { tone: 'danger', label: `${players}, over the ${max} maximum` };
  if (n < min) return { tone: 'warning', label: `${players} of ${min} minimum` };
  return { tone: 'success', label: players };
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
      <Button variant="secondary" className="button-sm" onClick={() => setOpen(true)}>
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
  names,
  selected,
  onSelect,
  profiles,
}: {
  request: PlacementRequest;
  entries: EntryNames;
  names: PersonNames;
  selected: boolean;
  onSelect: (request: PlacementRequest | null) => void;
  profiles: SeasonPlayerProfiles | undefined;
}) {
  const badge = PLACEMENT_STATUS[request.status];
  const entry = names.get(request.participantPersonId);
  const placeable = request.status === 'unassigned' || request.status === 'proposed';
  return (
    <li aria-labelledby={`placement-${request.id}`} data-selected={selected}>
      <div className="place-player">
        <span className="place-avatar" aria-hidden="true">
          {entry ? initials(entry.displayName) : '?'}
        </span>
        <div className="row-text">
          <span className="row-title" id={`placement-${request.id}`}>
            <PersonName personId={request.participantPersonId} names={names} />
          </span>
          <span className="caption">Requested {formatInstant(request.createdAt)}</span>
        </div>
      </div>
      <span className="actions-row">
        <StatusBadge tone={badge.tone} label={`Placement ${badge.label}`} />
        {request.requestedTeammatePersonIds.length > 0 ? (
          <StatusBadge
            tone="info"
            label={`Friend request (${request.requestedTeammatePersonIds.length})`}
          />
        ) : null}
      </span>
      <PlacementInformation request={request} names={names} />
      {profiles ? (
        <ProfileEditor
          seasonId={request.seasonId}
          personId={request.participantPersonId}
          personName={entry?.displayName ?? 'the entrant'}
          profiles={profiles}
        />
      ) : null}
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
      <div className="actions-row">
        {placeable ? (
          <Button
            variant={selected ? 'primary' : 'secondary'}
            className="button-sm"
            aria-expanded={selected}
            onClick={() => onSelect(selected ? null : request)}
          >
            {selected ? 'Hide candidate teams' : 'Show candidate teams'}
          </Button>
        ) : null}
        {request.status === 'proposed' ? (
          <ReasonedAction request={request} kind="reject-proposal" />
        ) : null}
        {request.status === 'assigned' ? <ReasonedAction request={request} kind="release" /> : null}
      </div>
    </li>
  );
}

interface Column {
  teamEntryId: string;
  teamName: string;
  entry: TeamEntry | undefined;
  candidate: PlacementCandidate | undefined;
}

function TeamColumnHead({
  column,
  band,
  profiles,
}: {
  column: Column;
  band: string;
  profiles: SeasonPlayerProfiles | undefined;
}) {
  const check = column.entry ? rosterCheck(column.entry) : null;
  return (
    <div className="place-col-head" style={{ ['--team-color' as string]: band }}>
      <div className="place-col-title">
        <h4 id={`team-${column.teamEntryId}`}>{column.teamName}</h4>
        {column.entry ? (
          <span className="place-count">
            {column.entry.rosterCount} / {column.entry.rosterMax}
          </span>
        ) : null}
      </div>
      <span className="actions-row">
        {check ? <StatusBadge tone={check.tone} label={check.label} /> : null}
        {column.entry?.rosterComplete ? (
          <StatusBadge tone="success" label="Roster complete" />
        ) : null}
        <BalanceBadges
          balance={profiles?.teams.find((b) => b.teamEntryId === column.teamEntryId)}
        />
      </span>
    </div>
  );
}

/**
 * The team columns. With an entrant selected they are that entrant's candidate teams (the
 * "Candidate teams" list), each with its placement controls; teams the API did not offer follow,
 * marked as not offered.
 */
function TeamColumns({
  selected,
  entries,
  entrantName,
  profiles,
}: {
  selected: PlacementRequest | null;
  entries: readonly TeamEntry[];
  entrantName: string;
  profiles: SeasonPlayerProfiles | undefined;
}) {
  const candidates = useApiQuery({
    path: '/placement-requests/{id}/candidates',
    request: { path: { id: selected?.id ?? '' } },
    enabled: !!selected,
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
    if (!selected) return;
    setLast({ kind, teamEntryId });
    const options = {
      path: { id: selected.id },
      body: { teamEntryId, expectedRevision: selected.revision },
    };
    const sent = kind === 'propose' ? propose.submit(options) : assign.submit(options);
    void sent.catch(() => undefined);
  };
  const error = propose.error ?? assign.error;

  const approved = entries.filter((e) => e.status === 'approved');
  const byEntry = new Map(approved.map((e) => [e.id, e]));
  const offered = candidates.data ?? [];
  const offeredIds = new Set(offered.map((c) => c.teamEntryId));
  const columns: Column[] = selected
    ? [
        // Recommended first, then eligible, then the rest the API offered, in its order.
        ...[...offered]
          .sort(
            (a, b) =>
              Number(b.recommended) - Number(a.recommended) ||
              Number(b.eligible) - Number(a.eligible),
          )
          .map((c) => ({
            teamEntryId: c.teamEntryId,
            teamName: c.teamName,
            entry: byEntry.get(c.teamEntryId),
            candidate: c,
          })),
        ...approved
          .filter((e) => !offeredIds.has(e.id))
          .map((e) => ({
            teamEntryId: e.id,
            teamName: e.teamName,
            entry: e,
            candidate: undefined,
          })),
      ]
    : approved.map((e) => ({
        teamEntryId: e.id,
        teamName: e.teamName,
        entry: e,
        candidate: undefined,
      }));
  const bandOf = new Map(approved.map((e, i) => [e.id, TEAM_BANDS[i % TEAM_BANDS.length] ?? '']));

  const list = (
    <ul className="place-teams" aria-label={selected ? 'Candidate teams' : 'Teams of the season'}>
      {columns.map((column) => {
        const c = column.candidate;
        return (
          <li
            key={column.teamEntryId}
            className="place-col place-team"
            data-candidate={selected ? String(!!c) : undefined}
            aria-labelledby={`team-${column.teamEntryId}`}
          >
            <TeamColumnHead
              column={column}
              band={bandOf.get(column.teamEntryId) ?? '#8a948f'}
              profiles={profiles}
            />
            <div className="place-col-body">
              {selected && c ? (
                <div className="place-move" data-eligible={String(c.eligible)}>
                  <span className="actions-row">
                    <StatusBadge
                      tone={c.eligible ? 'success' : 'danger'}
                      label={c.eligible ? 'Eligible' : 'Not eligible'}
                    />
                    {c.recommended ? <StatusBadge tone="info" label="Recommended" /> : null}
                  </span>
                  <span className="caption">
                    {c.capacity
                      ? `${c.capacity.available} of ${c.capacity.capacity} roster places free`
                      : 'No roster capacity limit recorded'}
                    {selected.requestedTeammatePersonIds.length > 0
                      ? ` · friend request: ${c.requestedTeammatesOnRoster} of ${selected.requestedTeammatePersonIds.length} requested teammates on this roster`
                      : ''}
                  </span>
                  <ReasonList reasons={c.reasons} label={`Reasons for ${c.teamName}`} />
                  <div className="actions-row">
                    {selected.status === 'unassigned' ? (
                      <CommandButton
                        variant="secondary"
                        className="button-sm"
                        busy={propose.isProcessing && last?.teamEntryId === c.teamEntryId}
                        aria-label={`Propose ${c.teamName}`}
                        onClick={() => send('propose', c.teamEntryId)}
                      >
                        Propose
                      </CommandButton>
                    ) : null}
                    <CommandButton
                      className="button-sm"
                      busy={assign.isProcessing && last?.teamEntryId === c.teamEntryId}
                      onClick={() => send('assign', c.teamEntryId)}
                    >
                      Assign to {c.teamName}
                    </CommandButton>
                  </div>
                </div>
              ) : selected ? (
                <p className="place-empty">Not offered as a candidate for {entrantName}.</p>
              ) : (
                <p className="place-empty">
                  {column.entry
                    ? `${column.entry.rosterCount} on the roster. Select an entrant to see whether this team can take them.`
                    : 'Select an entrant to see whether this team can take them.'}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );

  return (
    <section className="place-board-teams" aria-labelledby="place-teams-title">
      <h3 id="place-teams-title" className="sr-only-caption">
        Teams
      </h3>
      {selected ? (
        <p className="caption">
          A recommendation reserves nothing: capacity and eligibility are checked again when you
          assign.
        </p>
      ) : null}
      {selected ? (
        <QueryBoundary
          query={candidates}
          label="candidate teams"
          isEmpty={(data) => data.length === 0 && approved.length === 0}
          empty={{
            title: 'No candidate teams',
            description: 'No approved team of this season can take this entrant now.',
          }}
          unavailableOffline={['proposing and assigning placements']}
        >
          {() => list}
        </QueryBoundary>
      ) : columns.length === 0 ? (
        <div className="state">
          <StatusBadge tone="neutral" label="No approved teams yet" />
          <p className="caption">
            Approved team entries of this season appear here as columns. Entrants can still be
            selected to see the API&apos;s candidate teams.
          </p>
        </div>
      ) : (
        list
      )}
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

/** One chip with the roster limits when every approved team has the same (from the rule set). */
function rosterRule(entries: readonly TeamEntry[]): string | null {
  const limits = new Set(entries.map((e) => `${e.rosterMin}–${e.rosterMax}`));
  return limits.size === 1 ? `Roster ${[...limits][0]}` : null;
}

export function PlacementBoardScreen() {
  const { seasonId = '' } = useParams();
  const [status, setStatus] = useState<PlacementStatus | ''>('unassigned');
  const [selected, setSelected] = useState<PlacementRequest | null>(null);
  const { byId, query: entriesQuery } = useSeasonEntries(seasonId);
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
  const names = usePersonNames(
    (requests.data?.items ?? []).flatMap((r) => [
      r.participantPersonId,
      ...r.requestedTeammatePersonIds,
    ]),
  );
  const profiles = usePlayerProfiles(seasonId);
  // The freshest copy of the selected entrant (its revision), or the one chosen if it left the
  // list after a placement.
  const current = selected
    ? (requests.data?.items.find((r) => r.id === selected.id) ?? selected)
    : null;
  const selectedName = current ? names.get(current.participantPersonId)?.displayName : undefined;
  const entries = entriesQuery.data ?? [];
  const approved = entries.filter((e) => e.status === 'approved');
  const rule = rosterRule(approved);
  const waiting = requests.data?.items.length;
  return (
    <section aria-labelledby="placement-title" className="compete">
      <CompeteHeader
        eyebrow={
          <SeasonEyebrow
            seasonId={seasonId}
            extra={
              waiting !== undefined && status === 'unassigned'
                ? `${waiting}${requests.data?.nextCursor ? '+' : ''} waiting for a team`
                : undefined
            }
          />
        }
        title="Placement board"
        titleId="placement-title"
        actions={
          <span className="place-hint" aria-live="polite">
            {current
              ? `Choose a team for ${selectedName ?? 'the selected entrant'}`
              : 'Select an entrant, then a team'}
          </span>
        }
        chips={
          <>
            {rule ? <span className="chip chip-outline">{rule}</span> : null}
            <span className="chip chip-outline">
              {approved.length} approved {approved.length === 1 ? 'team' : 'teams'}
            </span>
            <span className="chip chip-outline">Capacity checked when you assign</span>
            {profiles.data ? (
              <>
                <span className="chip chip-outline">At least 1 keeper per team</span>
                <span className="chip chip-outline">
                  Skill {profiles.data.skillScale.min} to {profiles.data.skillScale.max}, staff
                  rated
                </span>
              </>
            ) : null}
          </>
        }
      />
      <SeasonLinks seasonId={seasonId} />
      <PendingNote decision={PENDING.placementModel} />
      {profiles.error && !profiles.data ? (
        <p className="caption" role="note">
          Keeper and skill checks are not available to you: staff player profiles could not be read
          ({profiles.error.code}).
        </p>
      ) : null}
      <div className="place-board">
        <section className="place-col place-col-unplaced" aria-labelledby="unplaced-title">
          <div className="place-col-head">
            <div className="place-col-title">
              <h3 id="unplaced-title">Entrants</h3>
              {waiting !== undefined ? <span className="place-count">{waiting}</span> : null}
            </div>
            <SelectField
              label="Placement state"
              value={status}
              onChange={(v) => {
                setStatus(v as PlacementStatus | '');
                setSelected(null);
                pages.reset();
              }}
              options={Object.entries(PLACEMENT_STATUS).map(([value, b]) => ({
                value,
                label: b.label,
              }))}
              placeholder="All states"
            />
          </div>
          <div className="place-col-body">
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
                  <ul className="place-requests" aria-label="Placement requests">
                    {data.items.map((request) => (
                      <RequestCard
                        key={request.id}
                        request={request}
                        entries={byId}
                        names={names}
                        selected={current?.id === request.id}
                        onSelect={setSelected}
                        profiles={profiles.data}
                      />
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
          </div>
        </section>
        <TeamColumns
          key={current?.id ?? 'none'}
          selected={current}
          entries={entries}
          entrantName={selectedName?.split(' ')[0] ?? 'the entrant'}
          profiles={profiles.data}
        />
      </div>
    </section>
  );
}
