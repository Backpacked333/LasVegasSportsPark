/**
 * SCR-S-17 Roster management (SPK-COMP-005 effective-dated memberships, SPK-CAP-004 guests and
 * substitutes never bypass eligibility, SPK-DISC-003 suspensions through the approved rule set,
 * SPK-AT-013, POL-032, SPK-UX-008). The roster is shown as of a chosen instant, so a player
 * removed today still appears on last week's match record; history adds pending and removed rows.
 * Adding a player is checked by the API against the rule set's restrictions and active
 * suspensions: ELIGIBILITY_FAILED lists every reason with who resolves it, and nothing is changed.
 * A concurrent roster edit answers STALE_REVISION and offers "Reload". A player is found by name
 * or contact through the staff person search (`GET /v1/people`, ID-02; names, kind and status
 * only) or entered by the reference on their record; overriding an eligibility failure is
 * pending DEC-066 and not offered. Adding and removing players are offered only when the team
 * workspace's `viewer.availableActions` (CMP-02, `GET /v1/team-entries/{id}`) holds
 * `competition.manage_roster` for this entry in its current state; the API still decides and its
 * ACCESS_DENIED is shown as not available.
 *
 * Times (SPK-SCHED-008): "Roster as of", "Effective from" and "Effective until" are read, and the
 * roster's dates shown, in the time zone of the division's facility when it is known; otherwise in
 * the device's zone. Every date-and-time field names its clock in its hint. A time typed before the
 * zone is known is not read in a guessed zone, and a time that happens twice or never on a
 * daylight-saving change is refused with a field error ("Ambiguous or nonexistent times require
 * resolution"): a change posts nothing, and "Roster as of" says the roster is shown as of now.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { hasAnswered } from '../../api/facility-directory';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useNow } from '../../providers/AppProviders';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, ReasonList } from '../../features/competition/CommandError';
import { useDivisionClock, type FacilityClock } from '../../features/competition/facilities';
import { keys, PendingNote, SuccessNote, useRefetch } from '../../features/competition/feedback';
import {
  CheckboxField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  isRecordReference,
  parseWholeNumber,
} from '../../features/competition/fields';
import { formatInstant, isoToZonedInput } from '../../features/competition/format';
import { ROSTER_ELIGIBILITY, ROSTER_STATUS, humanizeCode } from '../../features/competition/labels';
import { TeamsNav } from '../../features/competition/nav';
import { PENDING } from '../../features/competition/pending';
import { PersonSearchField } from '../../features/competition/PersonSearchField';
import { readZonedInput, type ZonedInput } from '../../features/schedule-facilities/time';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { inputZoneHint } from '../../ui/time';

type Member = Schema<'RosterMember'>;
type Workspace = Schema<'TeamEntryWorkspace'>;
type PlayingStatus = Schema<'RosterPlayingStatus'>;

const ROSTER_KEYS = keys('/team-entries/{id}/roster', '/team-entries/{id}', '/team-entries');
/** The roster command's action id, as listed in the workspace's `viewer.availableActions`. */
export const MANAGE_ROSTER_ACTION = 'competition.manage_roster';

/** The hint naming the clock of a roster date-and-time field (SPK-SCHED-008). */
function clockHint(clock: FacilityClock): string {
  return clock.settled ? inputZoneHint(clock.zone) : "Finding the facility's time zone.";
}

/** The field error of a roster change whose time was typed before the facility's zone is known. */
const CLOCK_LOADING_ERROR = "The facility's time zone is still loading. Try again in a moment.";

/**
 * A typed roster date and time as an instant in the roster's clock (SPK-SCHED-008): `{}` when the
 * field is empty (now); `{ error }` when the zone is not known yet, or the value is not a date and
 * time or happens twice or never on a daylight-saving change (never guessed).
 */
function readRosterTime(value: string, clock: FacilityClock): ZonedInput {
  if (!value.trim()) return {};
  if (!clock.settled) return { error: CLOCK_LOADING_ERROR };
  return readZonedInput(value, clock.zone);
}

function EligibilityIndicator({ member }: { member: Member }) {
  const indicator = member.eligibility;
  if (!indicator) return <StatusBadge tone="pending" label={ROSTER_ELIGIBILITY.unknown.label} />;
  const badge = ROSTER_ELIGIBILITY[indicator.status];
  return (
    <span>
      <StatusBadge tone={badge.tone} label={badge.label} />
      {indicator.blocking > 0 || indicator.warnings > 0 ? (
        <span className="caption">
          {' '}
          {indicator.blocking} blocking, {indicator.warnings} warning
          {indicator.codes.length > 0 ? `: ${indicator.codes.map(humanizeCode).join(', ')}` : ''}
        </span>
      ) : null}
    </span>
  );
}

function ExplainEligibility({
  entryId,
  member,
  zone,
}: {
  entryId: string;
  member: Member;
  zone: string | null;
}) {
  const [open, setOpen] = useState(false);
  const playing: PlayingStatus =
    member.status === 'guest' || member.status === 'substitute' ? member.status : 'active';
  const evaluation = useApiQuery({
    path: '/team-entries/{id}/eligibility',
    request: { path: { id: entryId }, query: { personId: member.personId, status: playing } },
    enabled: open,
  });
  return (
    <div>
      <Button
        variant="secondary"
        aria-expanded={open}
        aria-label={`Explain eligibility of ${member.displayName}`}
        onClick={() => setOpen((o) => !o)}
      >
        Explain eligibility
      </Button>
      {open ? (
        <QueryBoundary
          query={evaluation}
          label="the eligibility evaluation"
          empty={{ title: '', description: '' }}
        >
          {(data) => (
            <div>
              <StatusBadge
                tone={data.eligible ? 'success' : 'danger'}
                label={data.eligible ? 'Eligible' : 'Not eligible'}
              />
              <span className="caption"> Evaluated {formatInstant(data.evaluatedAt, zone)}</span>
              {data.reasons.length === 0 ? (
                <p>No restriction applies.</p>
              ) : (
                <ReasonList reasons={data.reasons} label="Eligibility reasons" />
              )}
            </div>
          )}
        </QueryBoundary>
      ) : null}
    </div>
  );
}

/**
 * Roster changes carry the team entry's revision (SCR-S-17): two staff editing the same roster at
 * once get STALE_REVISION and "Reload" instead of a silent lost update.
 */
function RemoveMember({
  entryId,
  entryRevision,
  member,
  clock,
}: {
  entryId: string;
  entryRevision: number;
  member: Member;
  clock: FacilityClock;
}) {
  const change = useApiCommand('post', '/team-entries/{id}/roster', { invalidate: ROSTER_KEYS });
  const reload = useRefetch(['/team-entries/{id}/roster', '/team-entries/{id}']);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const submit = () => {
    const until = readRosterTime(effectiveTo, clock);
    setError(reason.trim() ? null : 'Give the reason for the removal.');
    setToError(until.error ?? null);
    if (!reason.trim() || until.error) return;
    const to = until.iso;
    void change
      .submit({
        path: { id: entryId },
        body: {
          expectedRevision: entryRevision,
          changes: [
            {
              action: 'remove',
              personId: member.personId,
              reason: reason.trim(),
              ...(to ? { effectiveTo: to } : {}),
            },
          ],
        },
      })
      .catch(() => undefined);
  };
  if (!open) {
    return (
      <Button
        variant="secondary"
        aria-label={`Remove ${member.displayName} from the roster`}
        onClick={() => setOpen(true)}
      >
        Remove
      </Button>
    );
  }
  return (
    <form
      className="form"
      noValidate
      aria-label={`Remove ${member.displayName}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField label="Reason" required value={reason} onChange={setReason} error={error} />
      <TextField
        label="Effective until"
        type="datetime-local"
        value={effectiveTo}
        onChange={setEffectiveTo}
        hint={`Leave empty for now. Past matches keep the player on their record. ${clockHint(clock)}`}
        error={toError}
      />
      <div className="actions">
        <CommandButton type="submit" variant="secondary" busy={change.isProcessing}>
          Remove from the roster
        </CommandButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {change.status === 'success' ? (
        <SuccessNote>{`${member.displayName} removed`}</SuccessNote>
      ) : null}
      <CommandError
        error={change.error}
        onRetry={submit}
        onReload={() => {
          change.reset();
          reload();
        }}
      />
    </form>
  );
}

function AddMember({ workspace, clock }: { workspace: Workspace; clock: FacilityClock }) {
  const change = useApiCommand('post', '/team-entries/{id}/roster', { invalidate: ROSTER_KEYS });
  const reload = useRefetch(['/team-entries/{id}/roster', '/team-entries/{id}']);
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [jersey, setJersey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = () => {
    const next: Record<string, string> = {};
    if (!isRecordReference(person))
      next.person = 'Find the player by name, or enter the reference from their record.';
    if (!status) next.status = 'Choose active, guest or substitute.';
    const number = jersey.trim() ? parseWholeNumber(jersey) : null;
    if (jersey.trim() && (number === null || number < 0 || number > 999))
      next.jersey = 'Enter 0 to 999, or leave empty.';
    const start = readRosterTime(from, clock);
    if (start.error) next.from = start.error;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const effectiveFrom = start.iso;
    void change
      .submit({
        path: { id: workspace.entry.id },
        body: {
          expectedRevision: workspace.entry.revision,
          changes: [
            {
              action: 'add',
              personId: person.trim(),
              status: status as PlayingStatus,
              ...(effectiveFrom ? { effectiveFrom } : {}),
              ...(number !== null ? { jerseyNumber: number } : {}),
            },
          ],
        },
      })
      .catch(() => undefined);
  };
  const added = change.data?.members.find((m) => m.personId === person.trim());
  return (
    <form
      className="form"
      noValidate
      aria-label="Add a player"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <PersonSearchField
        label="Player"
        required
        value={person}
        onChange={setPerson}
        error={errors.person}
      />
      <SelectField
        label="Playing status"
        required
        value={status}
        onChange={setStatus}
        options={[
          { value: 'active', label: 'Active player' },
          { value: 'guest', label: 'Guest player' },
          { value: 'substitute', label: 'Substitute' },
        ]}
        error={errors.status}
        hint="Guests and substitutes are checked against the same restrictions and suspensions."
      />
      <div className="field-grid">
        <TextField
          label="Effective from"
          type="datetime-local"
          value={from}
          onChange={setFrom}
          hint={`Leave empty for now. ${clockHint(clock)}`}
          error={errors.from}
        />
        <NumberField
          label="Jersey number"
          value={jersey}
          onChange={setJersey}
          error={errors.jersey}
        />
      </div>
      <CommandButton type="submit" busy={change.isProcessing}>
        Add to the roster
      </CommandButton>
      {change.status === 'success' ? (
        <SuccessNote>
          {added
            ? `${added.displayName} ${added.status}, effective from ${formatInstant(added.effectiveFrom, clock.zone)}`
            : 'Roster changed'}
        </SuccessNote>
      ) : null}
      <CommandError
        error={change.error}
        onRetry={submit}
        onReload={() => {
          change.reset();
          reload();
        }}
      />
    </form>
  );
}

function RosterPolicy({ ruleSetId }: { ruleSetId: string }) {
  const ruleSet = useApiQuery({
    path: '/rule-sets/{id}',
    request: { path: { id: ruleSetId } },
    staleTime: 5 * 60_000,
  });
  if (!ruleSet.data) return null;
  const roster = ruleSet.data.content.roster;
  return (
    <p className="caption" data-testid="roster-policy">
      Rule set {ruleSet.data.name}, version {ruleSet.data.version}: guests{' '}
      {roster.guestPlayersAllowed
        ? `allowed${roster.guestMaxConcurrent !== null ? ` (at most ${roster.guestMaxConcurrent} at once)` : ''}`
        : 'not allowed'}
      ; substitutes {roster.substitutesAllowed ? 'allowed' : 'not allowed'}
      {roster.guestOrSubstituteRequiresApproval
        ? '; a league manager adds guests and substitutes'
        : ''}
      .
    </p>
  );
}

export function RosterScreen() {
  const { entryId = '' } = useParams();
  const now = useNow();
  const [at, setAt] = useState('');
  const [history, setHistory] = useState(false);
  const [adding, setAdding] = useState(false);
  const workspace = useApiQuery({ path: '/team-entries/{id}', request: { path: { id: entryId } } });
  // CMP-02: what the kernel allows this viewer on this entry now; the client never decides it.
  const canManage = workspace.data?.viewer.availableActions.includes(MANAGE_ROSTER_ACTION) === true;
  const clock = useDivisionClock(workspace.data?.division?.id, hasAnswered(workspace));
  // A time that cannot be read (yet) is never sent: the roster stays as of now, and the field says so.
  const asOf = readRosterTime(at, clock);
  const atIso = asOf.iso;
  const asOfError = !asOf.error
    ? null
    : clock.settled
      ? `${asOf.error} The roster is shown as of now.`
      : "The facility's time zone is still loading: the roster is shown as of now until it is known.";
  const roster = useApiQuery({
    path: '/team-entries/{id}/roster',
    request: {
      path: { id: entryId },
      query: { ...(atIso ? { at: atIso } : {}), includeHistory: history ? 'true' : 'false' },
    },
  });
  return (
    <section aria-labelledby="roster-title">
      <h2 id="roster-title">Roster{workspace.data ? `: ${workspace.data.team.name}` : ''}</h2>
      <TeamsNav />
      {workspace.data ? (
        <p>
          <Link to={`/teams/seasons/${workspace.data.season.id}/entries`}>
            Team entries of {workspace.data.season.name}
          </Link>
          {workspace.data.division ? ` · Division ${workspace.data.division.name}` : ''}
        </p>
      ) : null}
      {workspace.data ? <RosterPolicy ruleSetId={workspace.data.ruleSet.id} /> : null}
      <PendingNote decision={PENDING.eligibilityOverride} />
      <div className="actions">
        <TextField
          label="Roster as of"
          type="datetime-local"
          value={at}
          onChange={setAt}
          hint={`Leave empty for now (${isoToZonedInput(now.toISOString(), clock.zone).replace('T', ' ')}). ${clockHint(clock)}`}
          error={asOfError}
        />
        <CheckboxField
          label="Include pending and removed rows"
          checked={history}
          onChange={setHistory}
        />
        {!workspace.data || canManage ? (
          <Button
            variant="secondary"
            aria-expanded={adding}
            onClick={() => setAdding((a) => !a)}
            disabled={!workspace.data}
          >
            {adding ? 'Close the add form' : 'Add a player'}
          </Button>
        ) : null}
      </div>
      {workspace.data && !canManage ? (
        <p className="caption" role="note" data-testid="roster-changes-unavailable">
          Adding and removing players is not available to you on this entry now.
        </p>
      ) : null}
      {adding && workspace.data && canManage ? (
        <AddMember workspace={workspace.data} clock={clock} />
      ) : null}
      <QueryBoundary
        query={roster}
        label="the roster"
        isEmpty={(data) => data.members.length === 0}
        empty={{
          title: 'No roster',
          description: 'Nobody is on this roster at that time. Use "Add a player" to add one.',
        }}
        unavailableOffline={['adding or removing players']}
      >
        {(data) => (
          <>
            <p className="caption">As of {formatInstant(data.at, clock.zone)}</p>
            <ul className="list" aria-label="Roster">
              {data.members.map((member) => {
                const badge = ROSTER_STATUS[member.status];
                return (
                  <li key={member.id} aria-labelledby={`member-${member.id}`}>
                    <div className="row-text">
                      <span className="row-title" id={`member-${member.id}`}>
                        {member.displayName}
                        {member.jerseyNumber !== null ? ` (#${member.jerseyNumber})` : ''}
                      </span>
                      <span>
                        <StatusBadge tone={badge.tone} label={`Roster ${badge.label}`} />{' '}
                        {member.statusBeforeRemoval ? (
                          <span className="caption">was {member.statusBeforeRemoval}</span>
                        ) : null}
                      </span>
                      <span className="caption">
                        Effective {formatInstant(member.effectiveFrom, clock.zone)} to{' '}
                        {member.effectiveTo ? formatInstant(member.effectiveTo, clock.zone) : 'now'}{' '}
                        · added by {humanizeCode(member.source)}
                      </span>
                      {member.removalReason ? (
                        <span className="caption">Removed: {member.removalReason}</span>
                      ) : null}
                      <EligibilityIndicator member={member} />
                    </div>
                    <div className="actions">
                      <ExplainEligibility entryId={entryId} member={member} zone={clock.zone} />
                      {member.status === 'active' ||
                      member.status === 'guest' ||
                      member.status === 'substitute' ? (
                        workspace.data && canManage ? (
                          <RemoveMember
                            entryId={entryId}
                            entryRevision={workspace.data.entry.revision}
                            member={member}
                            clock={clock}
                          />
                        ) : null
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
