/**
 * SCR-S-33 Assignment management and replacement, list view (SPK-STAFF-002, SPK-STAFF-003,
 * SPK-STAFF-004, SPK-READY-001, SPK-AT-012, SPK-REPORT-002).
 *
 * - Uncovered required slots for the facility's next seven days come from the uncovered
 *   assignments report (`GET /v1/reports/uncovered-assignments`): proposed and offered never count
 *   as covering (SPK-STAFF-002), and the labels say so.
 * - "Find candidates" on an uncovered slot ranks who could cover it although nobody holds an
 *   assignment to replace (`GET /v1/assignment-requirements/{id}/candidates`, SPK-STAFF-003);
 *   "Offer" sends the ordinary proposal with `offer: true` (`POST /v1/assignments`). Every
 *   candidate list names the official's grade and safeguarding certification with its expiry
 *   when the API reports them (qualification kinds configured in workforce, DEC-011 pending).
 * - Assignments (`GET /v1/assignments`) show all six states including "Proposed".
 * - Proposing (`POST /v1/assignments`) lets the API check qualification, availability, overlaps
 *   and turnaround (SPK-STAFF-003); its refusal is shown with its code and message. The person is
 *   chosen from the staff directory (`GET /v1/staff-directory`, ID-05), narrowed to officials or
 *   coaches by the kind of assignment and to the selected facility. The target is the uncovered
 *   slot's activity, or chosen from the facility's sessions (`GET /v1/sessions`, which carries the
 *   offering) and events and fixtures (`GET /v1/events`); a record id is only a fallback
 *   (AssignmentTarget).
 * - Times are in the facility's zone (SPK-SCHED-008): the report's scope zone, and for each
 *   assignment the zone of its facility (`GET /v1/facilities/{id}`).
 * - The client never decides who may manage assignments: ACCESS_DENIED renders as not available.
 * - Offline the screen is read-only (inventory SCR-S-33, §4.15): "Propose" and a failure's "Try
 *   again" are disabled with "Needs a connection" and nothing is queued or sent later. "Try again"
 *   resends exactly the proposal that was sent (same body, so the same idempotency key, §4.9).
 */
import { formatMinorUnits, presentationForError, type Schema } from '@sportspark/api-client';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, STAFF_TABS } from '../../features/operations/AreaTabs';
import {
  nameOf,
  useFacilityZone,
  useOperatingFacility,
  usePersonNames,
} from '../../features/operations/context';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import {
  CheckboxField,
  SelectField,
  TextField,
  fieldErrorsOf,
} from '../../features/operations/fields';
import {
  addDays,
  formatInstant,
  formatRange,
  humanize,
  localDate,
} from '../../features/operations/format';
import { ASSIGNMENT_STATUS } from '../../features/operations/labels';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandButton } from '../../ui/CommandButton';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { StaffPicker, type StaffRole } from '../../features/operations/StaffPicker';
import { AssignmentTargetPicker, type ChosenTarget, type TargetType } from './AssignmentTarget';
import { CompeteHeader, initials } from '../../features/competition/page';
import { CardHead } from '../../ui/Page';
import './staff.css';

type Assignment = Schema<'Assignment'>;
type AssignmentStatus = Schema<'AssignmentStatus'>;
type ReportRow = Schema<'ReportRow'>;

const STATUSES: readonly AssignmentStatus[] = [
  'proposed',
  'offered',
  'accepted',
  'declined',
  'withdrawn',
  'completed',
];

/** Assignment states whose slot can be offered to someone else (as on the assignment page). */
const REPLACEABLE: ReadonlySet<AssignmentStatus> = new Set(['offered', 'accepted', 'declined']);

/** "18:00" and "Sat 24 Oct" in the facility zone, for the condensed time column. */
function clockParts(iso: string, timeZone: string | null): { time: string; day: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { time: iso, day: '' };
  const zone = timeZone ? { timeZone } : {};
  try {
    return {
      time: new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        ...zone,
      }).format(date),
      day: new Intl.DateTimeFormat('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...zone,
      }).format(date),
    };
  } catch {
    return { time: date.toISOString().slice(11, 16), day: '' };
  }
}

export function AssignmentsScreen() {
  const facility = useOperatingFacility();
  const [proposal, setProposal] = useState<ProposalSeed | null>(null);
  const [replacing, setReplacing] = useState<Assignment | null>(null);
  const [openSlot, setOpenSlot] = useState<OpenSlotSeed | null>(null);
  return (
    <section aria-labelledby="assignments-title" className="compete staff-area">
      <CompeteHeader
        eyebrow="Compete · Staff and officials"
        title="Assignments and replacement"
        titleId="assignments-title"
        intro="Cover every required official and coach slot. Proposed and offered never count as covering; only an accepted assignment does."
        actions={<AreaTabs label="Staff and officials screens" tabs={STAFF_TABS} />}
      />
      <div className="season-grid">
        <div className="season-main">
          {facility.facilityId ? (
            <UncoveredSlots
              facilityId={facility.facilityId}
              today={facility.localDate}
              timezone={facility.timezone}
              onPropose={setProposal}
              onFindCandidates={(seed) => {
                setReplacing(null);
                setOpenSlot((current) => (current?.key === seed.key ? null : seed));
              }}
            />
          ) : (
            <div className="state">
              <StatusBadge tone="neutral" label="No facility chosen" />
              <p className="caption">
                Choose a facility in the header to see its uncovered required slots.
              </p>
            </div>
          )}
          <AssignmentList
            replacingId={replacing?.id ?? null}
            onReplace={(a) => {
              setOpenSlot(null);
              setReplacing((current) => (current?.id === a.id ? null : a));
            }}
          />
        </div>
        <aside className="season-side" aria-label="Cover a slot">
          <div className="ops-actions">
            <Button
              variant={proposal ? 'secondary' : 'primary'}
              onClick={() => setProposal(proposal ? null : {})}
            >
              {proposal ? 'Close the proposal form' : 'Propose an assignment'}
            </Button>
          </div>
          {proposal ? <ProposeForm key={JSON.stringify(proposal)} seed={proposal} /> : null}
          {openSlot ? (
            <OpenSlotCandidatesCard
              key={openSlot.key}
              seed={openSlot}
              onClose={() => setOpenSlot(null)}
            />
          ) : replacing ? (
            <ReplacementCandidatesCard
              key={replacing.id}
              assignment={replacing}
              onClose={() => setReplacing(null)}
            />
          ) : (
            <section className="card" aria-labelledby="replace-hint-title">
              <h3 id="replace-hint-title">Find a replacement</h3>
              <p className="caption">
                Choose &ldquo;Find candidates&rdquo; on an uncovered slot, or &ldquo;Find a
                replacement&rdquo; on an offered, accepted or declined assignment, to see who could
                cover it, ranked by the service&apos;s checks of qualification, availability and
                conflicts.
              </p>
            </section>
          )}
          <FeeSummary />
        </aside>
      </div>
    </section>
  );
}

interface ProposalSeed {
  targetType?: string;
  targetId?: string;
  /** The slot's title and start in the facility zone, shown instead of the record id. */
  title?: string;
  when?: string;
  kind?: string;
  role?: string;
}

interface OpenSlotSeed {
  key: string;
  requirementId: string;
  title: string;
  when: string | undefined;
  timezone: string | null;
}

function UncoveredSlots({
  facilityId,
  today,
  timezone,
  onPropose,
  onFindCandidates,
}: {
  facilityId: string;
  today: string | null;
  timezone: string | null;
  onPropose: (seed: ProposalSeed) => void;
  onFindCandidates: (seed: OpenSlotSeed) => void;
}) {
  const now = useNow(60_000);
  const from = today ?? localDate(now, timezone);
  const report = useApiQuery({
    path: '/reports/uncovered-assignments',
    request: { query: { facilityId, from, to: addDays(from, 7) } },
  });
  const text = (row: ReportRow, key: string) => {
    const v = row[key];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  };
  const count = (row: ReportRow, key: string) =>
    typeof row[key] === 'number' ? (row[key] as number) : 0;
  return (
    <section className="card card-flush" aria-labelledby="uncovered-title">
      <CardHead aside={<span className="caption">Propose someone for an open slot</span>}>
        <h3 id="uncovered-title">Uncovered required slots (next seven days)</h3>
      </CardHead>
      <div className="card-body">
        <QueryBoundary
          query={report}
          label="uncovered slots"
          isEmpty={(data) => data.rows.every((r) => count(r, 'uncovered') === 0)}
          empty={{
            title: 'Nothing uncovered',
            description:
              'Every required official and coach slot in the next seven days has an accepted assignment.',
          }}
        >
          {(data) => {
            const zone = data.scope.timezone ?? timezone;
            return (
              <ul className="cover-list" aria-label="Uncovered slots">
                {data.rows
                  .filter((r) => count(r, 'uncovered') > 0)
                  .map((row) => {
                    const start = text(row, 'start');
                    const when = start ? clockParts(start, zone) : null;
                    return (
                      <li
                        key={`${text(row, 'requirementId')}-${text(row, 'role')}`}
                        data-tone="danger"
                      >
                        <span className="cover-time">
                          {when?.time ?? 'No time'}
                          {when ? <small>{when.day}</small> : null}
                        </span>
                        <span className="cover-what">
                          <span className="row-title">{text(row, 'title')}</span>
                          <span className="caption">
                            {start ? formatInstant(start, zone) : ''} ·{' '}
                            {humanize(text(row, 'role'))}
                          </span>
                        </span>
                        <span className="cover-role">{humanize(text(row, 'role'))}</span>
                        <span className="cover-who">
                          <StatusBadge
                            tone="danger"
                            label={`${count(row, 'uncovered')} uncovered`}
                          />
                        </span>
                        <span className="cover-detail caption">
                          {count(row, 'required')} required, {count(row, 'accepted')} accepted;
                          offered {count(row, 'offered')} and proposed {count(row, 'proposed')} do
                          not cover.
                        </span>
                        <span className="cover-detail actions-row">
                          {text(row, 'requirementId') ? (
                            <Button
                              variant="secondary"
                              className="button-sm"
                              aria-label={`Find candidates for ${text(row, 'title')}, ${humanize(text(row, 'role'))}`}
                              onClick={() =>
                                onFindCandidates({
                                  key: `${text(row, 'requirementId')}-${text(row, 'role')}`,
                                  requirementId: text(row, 'requirementId'),
                                  title: `${humanize(text(row, 'role'))} · ${text(row, 'title')}`,
                                  when: start ? formatInstant(start, zone) : undefined,
                                  timezone: zone,
                                })
                              }
                            >
                              Find candidates
                            </Button>
                          ) : null}
                          <Button
                            variant="primary"
                            className="button-sm"
                            aria-label={`Propose someone for ${text(row, 'title')}, ${humanize(text(row, 'role'))}`}
                            onClick={() =>
                              onPropose({
                                targetType: text(row, 'targetType'),
                                targetId: text(row, 'targetId'),
                                title: text(row, 'title'),
                                when: start ? formatInstant(start, zone) : undefined,
                                kind: text(row, 'kind'),
                                role: text(row, 'role'),
                              })
                            }
                          >
                            Propose someone
                          </Button>
                        </span>
                      </li>
                    );
                  })}
              </ul>
            );
          }}
        </QueryBoundary>
      </div>
    </section>
  );
}

function AssignmentList({
  replacingId,
  onReplace,
}: {
  replacingId: string | null;
  onReplace: (a: Assignment) => void;
}) {
  const [status, setStatus] = useState<AssignmentStatus | ''>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const now = useNow(60_000);
  // `now` is a new Date on every render with a real clock: the window moves by whole minutes so
  // the query key stays put between renders (otherwise every render starts a new read).
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const from = useMemo(() => new Date(minute - 86_400_000).toISOString(), [minute]);
  const list = useApiQuery({
    path: '/assignments',
    request: { query: { status: status || undefined, from, limit: 50, cursor } },
  });
  const names = usePersonNames(
    useMemo(() => (list.data?.items ?? []).map((a) => a.personId), [list.data]),
  );
  return (
    <section className="card card-flush" aria-labelledby="assignment-list-title">
      <CardHead
        aside={
          <div className="toolbar">
            <SelectField
              label="Show"
              value={status}
              onChange={(v) => {
                setStatus(v as AssignmentStatus | '');
                setCursor(undefined);
              }}
              placeholder="Every state"
              options={STATUSES.map((s) => ({ value: s, label: ASSIGNMENT_STATUS[s].label }))}
            />
          </div>
        }
      >
        <h3 id="assignment-list-title">Assignments from yesterday on</h3>
      </CardHead>
      <div className="card-body">
        <QueryBoundary
          query={list}
          label="assignments"
          isEmpty={(data) => data.items.length === 0}
          empty={{
            title: 'No assignments',
            description: 'Assignments you propose or offer appear here.',
          }}
          unavailableOffline={['proposing, offering and withdrawing assignments']}
        >
          {(data) => (
            <>
              <ul className="cover-list" aria-label="Assignments">
                {[...data.items]
                  .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
                  .map((a) => (
                    <AssignmentRow
                      key={a.id}
                      assignment={a}
                      name={nameOf(names, a.personId)}
                      selected={replacingId === a.id}
                      onReplace={onReplace}
                    />
                  ))}
              </ul>
              <div className="ops-actions">
                {cursor ? (
                  <Button variant="secondary" onClick={() => setCursor(undefined)}>
                    Back to the first page
                  </Button>
                ) : null}
                {data.nextCursor ? (
                  <Button
                    variant="secondary"
                    onClick={() => setCursor(data.nextCursor ?? undefined)}
                  >
                    Next page
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

function AssignmentRow({
  assignment: a,
  name,
  selected,
  onReplace,
}: {
  assignment: Assignment;
  name: string;
  selected: boolean;
  onReplace: (a: Assignment) => void;
}) {
  const zone = useFacilityZone(a.facilityId);
  const badge = ASSIGNMENT_STATUS[a.status];
  const when = clockParts(a.scheduledStart, zone ?? null);
  const title = `${a.targetTitle}: ${humanize(a.role)} ${a.slot > 1 ? `(slot ${a.slot})` : ''}`;
  return (
    <li data-selected={selected} data-tone={a.status === 'declined' ? 'danger' : undefined}>
      <span className="cover-time">
        {when.time}
        <small>{when.day}</small>
      </span>
      <span className="cover-what">
        <Link to={`/staff/assignments/${a.id}`} className="row-title">
          {title}
        </Link>
        <span className="caption">
          {formatRange(a.scheduledStart, a.scheduledEnd, zone)} · {name} · {humanize(a.engagement)}
        </span>
      </span>
      <span className="cover-role">{humanize(a.role)}</span>
      <span className="cover-who">
        <StatusBadge tone={badge.tone} label={badge.label} />
        {REPLACEABLE.has(a.status) ? (
          <Button
            variant={selected ? 'primary' : 'secondary'}
            className="button-sm"
            aria-pressed={selected}
            aria-label={`Find a replacement for ${a.targetTitle}, ${humanize(a.role)}`}
            onClick={() => onReplace(a)}
          >
            Find a replacement
          </Button>
        ) : null}
      </span>
    </li>
  );
}

const REASON_RANK: Record<Schema<'ReplacementCandidateReason'>['severity'], number> = {
  positive: 2,
  info: 0,
  warning: -1,
  blocking: -10,
};

type Candidate = Schema<'ReplacementCandidate'>;

/** Eligible first; then more positive and fewer warning reasons; then the API's order. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const score = (c: Candidate) =>
    (c.eligible ? 100 : 0) + c.reasons.reduce((sum, r) => sum + REASON_RANK[r.severity], 0);
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((x, y) => score(y.c) - score(x.c) || x.i - y.i)
    .map((x) => x.c);
}

/** Grade and safeguarding in words (glyph plus text, never colour alone, SPK-UX-009). */
export function credentialsOf(c: Candidate): string[] {
  const out: string[] = [];
  if (c.grade) out.push(`Grade ${c.grade}`);
  const sg = c.safeguarding;
  if (sg) {
    const until = sg.validTo ? ` until ${sg.validTo.slice(0, 10)}` : '';
    out.push(
      sg.status === 'held'
        ? `✓ Safeguarding${until}`
        : sg.status === 'expired'
          ? '▲ Safeguarding expired'
          : sg.status === 'unverified'
            ? '▲ Safeguarding awaits verification'
            : '▲ No safeguarding certification',
    );
  }
  return out;
}

const PROFILE_CODES = new Set([
  'official_grade',
  'official_grade_unknown',
  'safeguarding_current',
  'safeguarding_missing',
  'safeguarding_unverified',
  'safeguarding_expired',
]);

function CandidateList({
  candidates,
  label,
  action,
}: {
  candidates: readonly Candidate[];
  label: string;
  action?: (c: Candidate) => ReactNode;
}) {
  return (
    <ol className="cand-list" aria-label={label}>
      {rankCandidates(candidates).map((c, i) => {
        const credentials = credentialsOf(c);
        // The credentials line says grade and safeguarding; their reasons are not repeated.
        const reasons = c.reasons.filter(
          (r) => !PROFILE_CODES.has(r.code) || credentials.length === 0,
        );
        return (
          <li key={c.personId} data-eligible={c.eligible}>
            <span className="rank" aria-hidden="true">
              {i + 1}
            </span>
            <span className="cand-avatar" aria-hidden="true">
              {initials(c.displayName)}
            </span>
            <span className="cand-text">
              <span className="row-title">{c.displayName}</span>
              {credentials.length > 0 ? (
                <span className="cand-credentials">{credentials.join(' · ')}</span>
              ) : null}
              <span className="cand-meta">
                {c.eligible ? 'Eligible' : 'Not eligible'}
                {reasons.length > 0 ? ` · ${reasons.map((r) => r.message).join(' · ')}` : ''}
              </span>
            </span>
            {action ? <span className="cand-action">{action(c)}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Ranked candidates for an open slot nobody holds (`GET /v1/assignment-requirements/{id}/candidates`,
 * SPK-STAFF-003). "Offer" proposes and offers in one command (`POST /v1/assignments`, offer:
 * true); the API checks qualification, availability, overlaps and turnaround again and its refusal
 * is shown with its code.
 */
function OpenSlotCandidatesCard({ seed, onClose }: { seed: OpenSlotSeed; onClose: () => void }) {
  const candidates = useApiQuery({
    path: '/assignment-requirements/{id}/candidates',
    request: { path: { id: seed.requirementId } },
  });
  const offer = useApiCommand('post', '/assignments', {
    invalidate: [
      ['api', '/assignments'],
      ['api', '/reports/uncovered-assignments'],
      ['api', '/assignment-requirements/{id}/candidates'],
    ],
  });
  const [offeredTo, setOfferedTo] = useState<string | null>(null);
  const send = (personId: string) => {
    const data = candidates.data;
    if (!data) return;
    setOfferedTo(personId);
    void offer
      .submit({
        body: {
          personId,
          kind: data.kind,
          targetType: data.targetType,
          targetId: data.targetId,
          ...(data.offeringId ? { offeringId: data.offeringId } : {}),
          role: data.role,
          offer: true,
        },
      })
      .catch(() => undefined);
  };
  return (
    <section className="card card-flush" aria-labelledby="open-slot-title">
      <div className="cand-head">
        <span className="cand-kicker">Open slot · uncovered</span>
        <h3 id="open-slot-title" className="cand-title">
          {seed.title}
        </h3>
        {seed.when ? <span className="caption">{seed.when}</span> : null}
      </div>
      <QueryBoundary
        query={candidates}
        label="candidates for the open slot"
        isEmpty={(data) => data.candidates.length === 0}
        empty={{
          title: 'No candidates',
          description:
            'Nobody holds the required qualifications and is free at this time. The slot stays uncovered until someone is assigned.',
        }}
        unavailableOffline={['offering the open slot']}
      >
        {(data) => (
          <>
            <p className="label-caps card-pad">
              {data.covered} of {data.requiredCount} covered
              {data.requiredQualifications.length > 0
                ? ` · requires ${data.requiredQualifications.map(humanize).join(', ')}`
                : ''}
            </p>
            <CandidateList
              candidates={data.candidates}
              label="Ranked candidates for the open slot"
              action={(c) =>
                offer.status === 'success' && offeredTo === c.personId ? (
                  <StatusBadge tone="info" label="Offered" />
                ) : c.eligible ? (
                  <CommandButton
                    className="button-sm"
                    busy={offer.isProcessing && offeredTo === c.personId}
                    aria-label={`Offer the slot to ${c.displayName}`}
                    onClick={() => send(c.personId)}
                  >
                    Offer
                  </CommandButton>
                ) : null
              }
            />
            <p className="card-note">Evaluated {formatInstant(data.evaluatedAt, seed.timezone)}</p>
          </>
        )}
      </QueryBoundary>
      <div className="card-body">
        {offer.error ? (
          <CommandError
            error={offer.error}
            onRetry={() => (offeredTo ? send(offeredTo) : undefined)}
          />
        ) : null}
        <Button variant="secondary" className="button-sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}

/**
 * Ranked replacement candidates for one assignment (`GET /v1/assignments/{id}/replacements`,
 * SPK-AT-012): availability, qualification and conflicts in one line per person, as the service
 * evaluated them. Offering needs a reason and the expected revision, so it happens on the
 * assignment's own page; this card links there.
 */
function ReplacementCandidatesCard({
  assignment: a,
  onClose,
}: {
  assignment: Assignment;
  onClose: () => void;
}) {
  const zone = useFacilityZone(a.facilityId);
  const candidates = useApiQuery({
    path: '/assignments/{id}/replacements',
    request: { path: { id: a.id } },
  });
  const badge = ASSIGNMENT_STATUS[a.status];
  return (
    <section className="card card-flush" aria-labelledby="replace-title">
      <div className="cand-head" data-tone={a.status === 'declined' ? undefined : 'neutral'}>
        <span className="cand-kicker">
          {a.status === 'declined' ? 'Needs cover' : 'Replacement'} · {badge.label}
        </span>
        <h3 id="replace-title" className="cand-title">
          {humanize(a.role)} · {a.targetTitle}
        </h3>
        <span className="caption">{formatRange(a.scheduledStart, a.scheduledEnd, zone)}</span>
      </div>
      <QueryBoundary
        query={candidates}
        label="replacement candidates"
        isEmpty={(data) => data.candidates.length === 0}
        empty={{
          title: 'No candidates',
          description:
            'Nobody holds the required qualifications and is free at this time. The slot stays uncovered until someone is assigned.',
        }}
        unavailableOffline={['offering the slot to a replacement']}
      >
        {(data) => (
          <>
            <p className="label-caps card-pad">
              Best matches
              {data.requiredQualifications.length > 0
                ? ` · requires ${data.requiredQualifications.map(humanize).join(', ')}`
                : ''}
            </p>
            <CandidateList candidates={data.candidates} label="Ranked replacement candidates" />
            <p className="card-note">Evaluated {formatInstant(data.evaluatedAt, zone)}</p>
          </>
        )}
      </QueryBoundary>
      <div className="card-body">
        <div className="actions-row">
          <Link className="button button-primary button-sm" to={`/staff/assignments/${a.id}`}>
            Offer the slot on the assignment page
          </Link>
          <Button variant="secondary" className="button-sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Fee claims waiting for approval (`GET /v1/fee-submissions?status=submitted`), per currency. */
function FeeSummary() {
  const fees = useApiQuery({
    path: '/fee-submissions',
    request: { query: { status: 'submitted', limit: 50 } },
  });
  const items = fees.data?.items ?? [];
  const totals = new Map<string, number>();
  for (const f of items)
    totals.set(f.currency, (totals.get(f.currency) ?? 0) + f.submittedAmountMinor);
  return (
    <section className="card" aria-labelledby="fee-summary-title">
      <div className="fee-summary-head">
        <h3 id="fee-summary-title">Fee approvals</h3>
        {totals.size > 0 ? (
          <strong>
            {[...totals].map(([currency, minor]) => formatMinorUnits(minor, currency)).join(' + ')}
            {fees.data?.nextCursor ? '+' : ''}
          </strong>
        ) : null}
      </div>
      <p className="caption">
        {fees.error && !fees.data
          ? presentationForError(fees.error) === 'unavailable'
            ? 'Fee claims are not available to you.'
            : `Fee claims could not load (${fees.error.code}).`
          : !fees.data
            ? 'Checking fee claims…'
            : items.length === 0
              ? 'No fee claims are waiting for approval.'
              : `${items.length}${fees.data.nextCursor ? '+' : ''} ${items.length === 1 ? 'claim' : 'claims'} waiting for approval.`}
      </p>
      <Link className="button button-secondary button-sm" to="/staff/fees">
        Review fee claims
      </Link>
    </section>
  );
}
const KIND_OPTIONS = ['official', 'coach', 'supervisor', 'organizer'].map((v) => ({
  value: v,
  label: humanize(v),
}));
const TARGET_OPTIONS = ['fixture', 'event', 'session'].map((v) => ({
  value: v,
  label: humanize(v),
}));
const ENGAGEMENT_OPTIONS = ['regular', 'temporary', 'substitute'].map((v) => ({
  value: v,
  label: humanize(v),
}));

/** The directory role that holds an assignment kind (supervisors and organisers: any staff). */
const ROLE_OF_KIND: Record<string, StaffRole | undefined> = {
  official: 'official',
  coach: 'coach',
};

const isTargetType = (v: string | undefined): v is TargetType =>
  v === 'fixture' || v === 'event' || v === 'session';

function ProposeForm({ seed }: { seed: ProposalSeed }) {
  const { facilityId, timezone } = useOperatingFacility();
  const { online } = useApp();
  const seededTarget: ChosenTarget | null =
    isTargetType(seed.targetType) && seed.targetId
      ? {
          targetType: seed.targetType,
          targetId: seed.targetId,
          offeringId: null,
          title: seed.title || `The ${seed.targetType} of the uncovered slot`,
          when: seed.when ?? null,
        }
      : null;
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState(seed.kind ?? '');
  const [targetType, setTargetType] = useState(seed.targetType ?? '');
  const [target, setTarget] = useState<ChosenTarget | null>(seededTarget);
  const [fromSlot, setFromSlot] = useState(seededTarget !== null);
  const [role, setRole] = useState(seed.role ?? '');
  const [engagement, setEngagement] = useState('regular');
  const [turnaround, setTurnaround] = useState('');
  const [offer, setOffer] = useState(true);
  const [missing, setMissing] = useState<Record<string, string>>({});
  const targetId = target?.targetId ?? '';
  // A session from the uncovered slot names no offering: its requirement read does (WRK-02).
  const requirement = useApiQuery({
    path: '/assignment-requirements',
    request: { query: { targetType: 'session', targetId } },
    enabled: targetType === 'session' && targetId.length > 0 && !target?.offeringId,
  });
  const sessionOffering =
    target?.offeringId ?? requirement.data?.find((r) => r.offeringId)?.offeringId ?? null;
  const command = useApiCommand('post', '/assignments', { invalidate: [['api', '/assignments']] });
  const apiErrors = fieldErrorsOf(command.error);

  // Offline nothing is proposed or queued (§4.15): the control is disabled and nothing is sent.
  const submit = () => {
    if (!online) return;
    const next: Record<string, string> = {};
    if (!personId) next.personId = 'Choose the person from the staff directory.';
    if (!kind) next.kind = 'Choose the kind of assignment.';
    if (!targetType) next.targetType = 'Choose what the assignment is for.';
    else if (!targetId) next.targetId = `Choose the ${targetType}.`;
    if (!role.trim()) next.role = 'Name the role.';
    if (targetType === 'session' && targetId && !sessionOffering)
      next.targetId = 'A session needs its offering: choose the session from the list.';
    setMissing(next);
    if (Object.keys(next).length > 0) return;
    void command
      .submit({
        body: {
          personId,
          kind: kind as Assignment['kind'],
          targetType: targetType as Assignment['targetType'],
          targetId,
          ...(targetType === 'session' && sessionOffering ? { offeringId: sessionOffering } : {}),
          role: role.trim(),
          engagement: engagement as Assignment['engagement'],
          ...(turnaround.trim() ? { turnaroundMinutes: Number(turnaround) } : {}),
          offer,
        },
      })
      .catch(() => undefined);
  };

  const outcome = command.data;
  const outcomeZone = useFacilityZone(outcome?.assignment.facilityId);
  return (
    <section className="ops-section" aria-labelledby="propose-title">
      <h3 id="propose-title">Propose an assignment</h3>
      <form
        className="ops-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SelectField
          label="Kind"
          value={kind}
          onChange={(v) => {
            setKind(v);
            setPersonId('');
          }}
          options={KIND_OPTIONS}
          placeholder="Choose a kind"
          error={missing.kind ?? apiErrors.kind}
        />
        <StaffPicker
          key={kind}
          label="Person"
          value={personId}
          onChange={(id) => setPersonId(id)}
          facilityId={facilityId}
          role={ROLE_OF_KIND[kind]}
          hint="The service checks qualification, availability, overlaps and turnaround when you propose."
          error={missing.personId ?? apiErrors.personId}
        />
        <SelectField
          label="For"
          value={targetType}
          onChange={(v) => {
            setTargetType(v);
            setTarget(null);
            setFromSlot(false);
          }}
          options={TARGET_OPTIONS}
          placeholder="Choose a target"
          error={missing.targetType ?? apiErrors.targetType}
        />
        {fromSlot && target ? (
          <div className="ops-section" role="group" aria-label="The uncovered slot">
            <p data-testid="proposal-target">
              <strong>{target.title}</strong>
              {target.when ? ` · ${target.when}` : ''} (from the uncovered slot)
            </p>
            <div className="ops-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setTarget(null);
                  setFromSlot(false);
                }}
              >
                Choose another {humanize(target.targetType).toLowerCase()}
              </Button>
            </div>
          </div>
        ) : isTargetType(targetType) ? (
          <AssignmentTargetPicker
            key={targetType}
            targetType={targetType}
            facilityId={facilityId}
            value={target}
            onChange={setTarget}
            error={missing.targetId ?? apiErrors.targetId ?? apiErrors.offeringId}
          />
        ) : null}
        <TextField
          label="Role"
          value={role}
          onChange={setRole}
          required
          hint="For example referee or assistant_coach."
          error={missing.role ?? apiErrors.role}
        />
        <SelectField
          label="Engagement"
          value={engagement}
          onChange={setEngagement}
          options={ENGAGEMENT_OPTIONS}
          hint="Temporary and substitute work receives time-bounded access (SPK-STAFF-004)."
        />
        <TextField
          label="Turnaround minutes (optional)"
          value={turnaround}
          onChange={setTurnaround}
          inputMode="numeric"
          hint="Leave empty to apply the configured turnaround."
          error={apiErrors.turnaroundMinutes}
        />
        <CheckboxField label="Offer it to the person now" checked={offer} onChange={setOffer} />
        <div className="ops-actions">
          <CommandButton type="submit" busy={command.isProcessing}>
            {offer ? 'Propose and offer' : 'Propose'}
          </CommandButton>
        </div>
      </form>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError
          error={command.error}
          onRetry={() => {
            if (online) void command.resend().catch(() => undefined);
          }}
        />
      ) : null}
      {outcome ? (
        <CommandSuccess label={ASSIGNMENT_STATUS[outcome.assignment.status].label}>
          <Link to={`/staff/assignments/${outcome.assignment.id}`}>Manage this assignment</Link>
          {outcome.uncovered ? (
            <UncoveredNotice notice={outcome.uncovered} timezone={outcomeZone ?? timezone} />
          ) : null}
        </CommandSuccess>
      ) : null}
    </section>
  );
}

export function UncoveredNotice({
  notice,
  timezone,
}: {
  notice: NonNullable<Schema<'UncoveredAssignmentNotice'>>;
  /** The assignment's facility zone (SPK-SCHED-008); the device zone, labelled, when unknown. */
  timezone?: string | null;
}) {
  return (
    <StateView
      variant="unavailable"
      title="Slot uncovered: escalated"
      description={`The ${humanize(notice.role).toLowerCase()} slot ${notice.slot} from ${formatInstant(notice.startsAt, timezone)} has no accepted assignment. It is raised in the Today workspace for replacement.`}
    />
  );
}
