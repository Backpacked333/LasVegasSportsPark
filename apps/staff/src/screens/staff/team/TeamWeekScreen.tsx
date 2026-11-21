/**
 * Staff S 5b "Staff shifts · week, with a swap request" (desktop 1440, rail › Staff and officials;
 * SPK-STAFF-001 to SPK-STAFF-004, SPK-AT-012, §4.6 assignment machine, §4.8 only the assignee
 * accepts).
 *
 * Shifts are composed from assignments (the API has no shift record): one row per person with
 * their assignments of the week (`GET /v1/assignments?from&to`), a day's assignments shown as one
 * chip "4–8 Coach" from the first start to the last end, coloured by role (manager blue for a
 * supervisor or organizer, coach green, referee amber; the role is written too).
 *
 * - Open shifts: required roles nobody covers (`GET /v1/reports/uncovered-assignments`) are a red
 *   dashed row; clicking one lists who is free and qualified
 *   (`GET /v1/assignment-requirements/{id}/candidates`, eligible first, each with its reasons) and
 *   "Ask" offers the slot (`POST /v1/assignments` with `offer: true`; only the person accepts).
 * - Swap requests: a declined (or withdrawn) assignment whose replacement is proposed and not yet
 *   offered (`replacesAssignmentId`), with the decline reason as the note. The checks are the
 *   API's own (`GET /v1/assignments/{id}/replacements`: free, qualified, not declared unavailable,
 *   turnaround) plus the hours of the week from the grid against `WEEKLY_HOURS_LIMIT`. Approve
 *   offers the replacement to the person (`POST /v1/assignments/{id}/offer`): the session's coach
 *   changes when they accept. Decline withdraws the proposal with a reason.
 *
 * Proposed (pending tone): the 40-hour weekly limit is a constant, not a policy; telling the
 * families about a coach change has no notice in the API; "Add shift" (a shift without an
 * activity) does not exist in the API; a coach asking for a swap from their phone is not in the
 * API (the request is the decline reason and the manager's proposal).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { usePersonNames } from '../../../features/operations/context';
import { AreaTabs, STAFF_TABS } from '../../../features/operations/AreaTabs';
import {
  FacilityGate,
  type FacilityContext,
} from '../../../features/schedule-facilities/facility-scope';
import { useApiQuery } from '../../../api/useApiQuery';
import { useIntentSend } from '../../../api/useIntentSend';
import { useApi, useApp } from '../../../providers/AppProviders';
import { Avatar } from '../../../ui/Avatar';
import { Drawer } from '../../../ui/Drawer';
import { Icon } from '../../../ui/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { StateView } from '../../../ui/StateView';
import { useToast } from '../../../ui/Toast';
import { addDays, mondayOf, rangeLabel } from '../../reports/week/week-model';
import './team.css';

type StaffAssignment = Schema<'StaffAssignment'>;
type Candidate = Schema<'ReplacementCandidate'>;

/** Proposed: the hours a person may work in a week before a swap is flagged (not a policy yet). */
export const WEEKLY_HOURS_LIMIT = 40;

/** The candidate reason a proposed replacement gives about its own person (not a conflict). */
const SELF_PROPOSAL = 'already_on_slot';

const LIVE = new Set(['proposed', 'offered', 'accepted', 'completed']);
const COVERING = new Set(['accepted', 'completed']);

export type RoleTone = 'manager' | 'coach' | 'referee';

export function toneOf(kind: StaffAssignment['kind']): RoleTone {
  if (kind === 'coach') return 'coach';
  if (kind === 'official') return 'referee';
  return 'manager';
}

const ROLE_WORD: Record<RoleTone, string> = {
  manager: 'Manager',
  coach: 'Coach',
  referee: 'Referee',
};

/** "8–4", "9–12", "4:30–6" in the facility zone. */
export function hourRange(start: string, end: string, timeZone: string): string {
  const f = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone })
      .format(new Date(iso))
      .replace(/\s?[AP]M$/, '')
      .replace(/:00$/, '');
  return `${f(start)}–${f(end)}`;
}

export function localDateIn(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

export interface Swap {
  original: StaffAssignment;
  replacement: StaffAssignment;
}

/** Proposed replacements of a declined or withdrawn assignment: the swaps waiting for approval. */
export function swapsOf(items: readonly StaffAssignment[]): Swap[] {
  const byId = new Map(items.map((a) => [a.id, a]));
  const out: Swap[] = [];
  for (const a of items) {
    if (a.status !== 'proposed' || !a.replacesAssignmentId) continue;
    const original = byId.get(a.replacesAssignmentId);
    if (original && (original.status === 'declined' || original.status === 'withdrawn')) {
      out.push({ original, replacement: a });
    }
  }
  return out;
}

/** Hours of a person's covering assignments in the list. */
export function hoursOf(items: readonly StaffAssignment[], personId: string): number {
  return items
    .filter((a) => a.personId === personId && COVERING.has(a.status))
    .reduce(
      (sum, a) =>
        sum +
        (new Date(a.scheduledEnd).getTime() - new Date(a.scheduledStart).getTime()) / 3_600_000,
      0,
    );
}

export function TeamWeekScreen() {
  return (
    <section aria-label="Team" className="team-screen">
      <FacilityGate purpose="see its team">
        {(facility) => <TeamWeek key={facility.id} facility={facility} />}
      </FacilityGate>
    </section>
  );
}

interface OpenShift {
  requirementId: string;
  title: string;
  kind: StaffAssignment['kind'];
  role: string;
  start: string;
  end: string | null;
}

function TeamWeek({ facility }: { facility: FacilityContext }) {
  const api = useApi();
  const tz = facility.timezone;
  const today = facility.localDate ?? new Date().toISOString().slice(0, 10);
  const from = mondayOf(today);
  const to = addDays(from, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const startIso = new Date(`${addDays(from, -1)}T12:00:00Z`).toISOString();
  const endIso = new Date(`${addDays(to, 1)}T12:00:00Z`).toISOString();
  const assignments = useApiQuery({
    path: '/assignments',
    request: { query: { from: startIso, to: endIso, limit: 200, order: 'asc' } },
  });
  const uncovered = useApiQuery({
    path: '/reports/uncovered-assignments',
    request: { query: { facilityId: facility.id, from, to } },
  });
  const items = useMemo(
    () =>
      (assignments.data?.items ?? []).filter((a) => {
        const day = localDateIn(a.scheduledStart, tz);
        return a.facilityId === facility.id && day >= from && day <= to;
      }),
    [assignments.data, facility.id, tz, from, to],
  );
  const openRows = (uncovered.data?.rows ?? []).filter(
    (r) => typeof r['requirementId'] === 'string' && Number(r['uncovered'] ?? 0) > 0,
  );
  const candidates = useQueries({
    queries: openRows.map((r) => ({
      queryKey: [
        'api',
        '/assignment-requirements/{id}/candidates',
        { path: { id: r['requirementId'] as string } },
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (
          await api.request('get', '/assignment-requirements/{id}/candidates', {
            path: { id: r['requirementId'] as string },
            signal,
          })
        ).data,
      staleTime: 60_000,
    })),
  });
  const open: OpenShift[] = openRows.map((r, i) => {
    const c = candidates[i]?.data as Schema<'OpenSlotCandidates'> | undefined;
    return {
      requirementId: r['requirementId'] as string,
      title: String(r['title'] ?? ''),
      kind: (r['kind'] as StaffAssignment['kind']) ?? 'official',
      role: String(r['role'] ?? ''),
      start: String(r['start'] ?? ''),
      end: c?.scheduledEnd ?? null,
    };
  });
  const swaps = swapsOf(items);
  const people = useMemo(() => {
    const ids: string[] = [];
    for (const a of items) {
      if (!LIVE.has(a.status) || a.status === 'proposed') continue;
      if (!ids.includes(a.personId)) ids.push(a.personId);
    }
    for (const s of swaps) {
      if (!ids.includes(s.original.personId)) ids.push(s.original.personId);
      if (!ids.includes(s.replacement.personId)) ids.push(s.replacement.personId);
    }
    return ids;
  }, [items, swaps]);
  const names = usePersonNames(people);
  const nameOf = (id: string) => {
    const n = names.get(id);
    return n?.status === 'ok' ? n.name : 'Staff member';
  };
  const rowsSorted = [...people].sort((a, b) => {
    const rank = (id: string) => {
      const kinds = items.filter((x) => x.personId === id).map((x) => toneOf(x.kind));
      return kinds.includes('manager') ? 0 : kinds.includes('coach') ? 1 : 2;
    };
    return rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b));
  });
  const [openShift, setOpenShift] = useState<OpenShift | null>(null);
  const [swapIndex] = useState(0);
  const swap = swaps[swapIndex] ?? null;

  const cell = (personId: string, day: string) => {
    const mine = items.filter(
      (a) => a.personId === personId && localDateIn(a.scheduledStart, tz) === day,
    );
    const covering = mine.filter(
      (a) => a.status !== 'declined' && a.status !== 'withdrawn' && a.status !== 'proposed',
    );
    const declinedSwap = mine.find((a) => swaps.some((s) => s.original.id === a.id));
    if (covering.length === 0 && !declinedSwap) return null;
    const chips = [];
    if (covering.length > 0) {
      const first = covering.reduce((a, b) => (a.scheduledStart < b.scheduledStart ? a : b));
      const last = covering.reduce((a, b) => (a.scheduledEnd > b.scheduledEnd ? a : b));
      const tone = toneOf(first.kind);
      const offered = covering.every((a) => a.status === 'offered');
      chips.push(
        <span
          key="shift"
          className="team-chip"
          data-tone={tone}
          data-today={day === today || undefined}
          data-offered={offered || undefined}
          title={covering.map((a) => a.targetTitle).join(', ')}
        >
          <b>{hourRange(first.scheduledStart, last.scheduledEnd, tz)}</b> {ROLE_WORD[tone]}
          {offered ? ' · asked' : ''}
        </span>,
      );
    }
    if (declinedSwap) {
      chips.push(
        <span key="swap" className="team-chip" data-tone={toneOf(declinedSwap.kind)} data-swap>
          <b>{hourRange(declinedSwap.scheduledStart, declinedSwap.scheduledEnd, tz)}</b> ◷ swap
        </span>,
      );
    }
    return <span className="team-chips">{chips}</span>;
  };

  const loading = !assignments.data && !assignments.error;
  return (
    <div className="team">
      <header className="team-head">
        <div>
          <p className="team-kicker">
            {rangeLabel(from, to)} · {open.length} open {open.length === 1 ? 'shift' : 'shifts'} ·{' '}
            {swaps.length} {swaps.length === 1 ? 'swap' : 'swaps'} to approve
          </p>
          <h1 className="team-title">Team</h1>
        </div>
        <div className="team-head-actions">
          <AreaTabs label="Staff and officials screens" tabs={STAFF_TABS} />
          <button type="button" className="team-add" disabled aria-describedby="team-add-why">
            <Icon name="add" size={18} />
            Add shift
            <span className="team-proposed" id="team-add-why">
              ◷ Proposed
            </span>
          </button>
        </div>
      </header>
      <div className="team-grid">
        <section className="team-card" aria-label="Shifts this week">
          {assignments.error ? (
            <StateView
              variant="error"
              error={assignments.error}
              onRetry={() => void assignments.refetch()}
            />
          ) : loading ? (
            <Skeleton height={320} radius={16} />
          ) : (
            <table className="team-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  {days.map((d) => (
                    <th key={d} scope="col" data-today={d === today || undefined}>
                      {new Intl.DateTimeFormat('en-US', {
                        weekday: 'short',
                        timeZone: 'UTC',
                      }).format(new Date(`${d}T12:00:00Z`))}
                      {d === today ? ' · today' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowsSorted.map((personId) => (
                  <tr key={personId}>
                    <th scope="row">
                      <span className="team-person">
                        <Avatar name={nameOf(personId)} personKey={personId} size={30} decorative />
                        {nameOf(personId)}
                      </span>
                    </th>
                    {days.map((d) => (
                      <td key={d}>{cell(personId, d)}</td>
                    ))}
                  </tr>
                ))}
                {open.length > 0 ? (
                  <tr className="team-open-row">
                    <th scope="row">
                      <span className="team-person" data-open>
                        <span className="team-open-icon" aria-hidden="true">
                          <Icon name="person_add" size={16} />
                        </span>
                        Open
                      </span>
                    </th>
                    {days.map((d) => (
                      <td key={d}>
                        {open
                          .filter((o) => localDateIn(o.start, tz) === d)
                          .map((o) => (
                            <button
                              key={o.requirementId}
                              type="button"
                              className="team-chip team-open-chip"
                              onClick={() => setOpenShift(o)}
                              aria-label={`Open shift: ${o.title}, ${o.role}, needed. Who is free and qualified`}
                            >
                              <b>
                                {o.end
                                  ? hourRange(o.start, o.end, tz)
                                  : hourRange(o.start, o.start, tz).split('–')[0]}
                              </b>{' '}
                              {ROLE_WORD[toneOf(o.kind)]} · needed
                            </button>
                          ))}
                      </td>
                    ))}
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
          {!loading && rowsSorted.length === 0 && open.length === 0 ? (
            <StateView
              variant="empty"
              title="No shifts this week"
              description="Assignments of coaches, referees and managers appear here by day."
            />
          ) : null}
        </section>
        {swap ? (
          <SwapCard
            swap={swap}
            items={items}
            nameOf={nameOf}
            tz={tz}
            onDone={() => void assignments.refetch()}
          />
        ) : null}
      </div>
      <OpenShiftDrawer
        shift={openShift}
        tz={tz}
        onClose={() => setOpenShift(null)}
        onAsked={() => {
          setOpenShift(null);
          void assignments.refetch();
          void uncovered.refetch();
        }}
      />
    </div>
  );
}

function SwapCard({
  swap,
  items,
  nameOf,
  tz,
  onDone,
}: {
  swap: Swap;
  items: readonly StaffAssignment[];
  nameOf: (id: string) => string;
  tz: string;
  onDone: () => void;
}) {
  const { online } = useApp();
  const toast = useToast();
  const { send } = useIntentSend([['api', '/assignments']]);
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const checks = useApiQuery({
    path: '/assignments/{id}/replacements',
    request: { path: { id: swap.original.id } },
  });
  const candidate: Candidate | undefined = checks.data?.candidates.find(
    (c) => c.personId === swap.replacement.personId,
  );
  const from = nameOf(swap.original.personId);
  const to = nameOf(swap.replacement.personId);
  const firstOf = (n: string) => n.split(' ')[0] ?? n;
  const hours =
    hoursOf(items, swap.replacement.personId) +
    (new Date(swap.replacement.scheduledEnd).getTime() -
      new Date(swap.replacement.scheduledStart).getTime()) /
      3_600_000;
  const underLimit = hours <= WEEKLY_HOURS_LIMIT;
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(
    new Date(swap.original.scheduledStart),
  );
  // The proposal itself puts the person "already on the slot"; every other blocking reason counts.
  const blocking =
    candidate?.reasons.filter((r) => r.severity === 'blocking' && r.code !== SELF_PROPOSAL) ?? [];
  const positive = candidate?.reasons.filter((r) => r.severity === 'positive') ?? [];
  const eligible = candidate !== undefined && blocking.length === 0;

  const approve = async () => {
    setBusy('approve');
    try {
      await send(`swap-approve|${swap.replacement.id}`, 'post', '/assignments/{id}/offer', {
        path: { id: swap.replacement.id },
        body: { expectedRevision: swap.replacement.revision },
      });
      toast.show({
        tone: 'success',
        message: `Offered to ${firstOf(to)}. The session shows ${firstOf(to)} as coach once ${firstOf(to)} accepts.`,
      });
      onDone();
    } catch (error) {
      const code = (error as { code?: string }).code;
      toast.show({ tone: 'error', message: `The swap didn't save.${code ? ` Code ${code}` : ''}` });
    } finally {
      setBusy(null);
    }
  };
  const decline = async () => {
    setBusy('decline');
    try {
      await send(`swap-decline|${swap.replacement.id}`, 'post', '/assignments/{id}/withdraw', {
        path: { id: swap.replacement.id },
        body: {
          reason: 'Swap declined by the manager',
          expectedRevision: swap.replacement.revision,
        },
      });
      toast.show({ message: `Swap declined. ${firstOf(from)}'s slot is still open.` });
      onDone();
    } catch (error) {
      const code = (error as { code?: string }).code;
      toast.show({
        tone: 'error',
        message: `The decline didn't save.${code ? ` Code ${code}` : ''}`,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="team-card team-swap" aria-labelledby="swap-title">
      <h2 id="swap-title">Swap request</h2>
      <div className="team-swap-who">
        <Avatar name={from} personKey={swap.original.personId} size={40} decorative />
        <Icon name="arrow_forward" size={18} />
        <Avatar name={to} personKey={swap.replacement.personId} size={40} decorative />
        <span className="team-swap-text">
          <b>
            {firstOf(from)} → {firstOf(to)}
          </b>
          <small>
            {day} {hourRange(swap.original.scheduledStart, swap.original.scheduledEnd, tz)} ·{' '}
            {swap.original.targetTitle.replace(/\s*\(session \d+\)$/, '')}
          </small>
        </span>
      </div>
      {swap.original.declineReason || swap.original.withdrawnReason ? (
        <blockquote className="team-swap-note">
          “{swap.original.declineReason ?? swap.original.withdrawnReason}”
        </blockquote>
      ) : null}
      {checks.error ? (
        <StateView variant="error" error={checks.error} onRetry={() => void checks.refetch()} />
      ) : !checks.data ? (
        <Skeleton height={64} />
      ) : (
        <ul className="team-checks" aria-label="Checks">
          <li data-tone={eligible ? 'success' : 'danger'}>
            {eligible
              ? `✓ ${firstOf(to)} is free and qualified${positive[0] ? ` (${positive[0].message})` : ''}`
              : `✕ ${blocking[0]?.message ?? `${firstOf(to)} is not free or not qualified`}`}
          </li>
          <li data-tone={underLimit ? 'success' : 'danger'}>
            {underLimit ? '✓' : '✕'} {underLimit ? 'Under' : 'Over'} {WEEKLY_HOURS_LIMIT} h this
            week ({Math.round(hours)} h) <span className="team-proposed">◷ limit proposed</span>
          </li>
          <li data-tone="pending">◷ Families are not told of the coach change yet (proposed)</li>
        </ul>
      )}
      <div className="team-swap-actions">
        <button
          type="button"
          className="team-secondary"
          disabled={!online || busy !== null}
          onClick={() => void decline()}
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        <button
          type="button"
          className="team-primary"
          disabled={!online || busy !== null || !eligible}
          onClick={() => void approve()}
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
      </div>
    </section>
  );
}

function OpenShiftDrawer({
  shift,
  tz,
  onClose,
  onAsked,
}: {
  shift: OpenShift | null;
  tz: string;
  onClose: () => void;
  onAsked: () => void;
}) {
  const { online } = useApp();
  const toast = useToast();
  const { send } = useIntentSend([
    ['api', '/assignments'],
    ['api', '/reports/uncovered-assignments'],
  ]);
  const [asking, setAsking] = useState<string | null>(null);
  const list = useApiQuery({
    path: '/assignment-requirements/{id}/candidates',
    request: { path: { id: shift?.requirementId ?? '' } },
    enabled: !!shift,
  });
  const ask = async (c: Candidate) => {
    if (!list.data) return;
    setAsking(c.personId);
    try {
      await send(`ask|${list.data.requirementId}|${c.personId}`, 'post', '/assignments', {
        body: {
          personId: c.personId,
          kind: list.data.kind,
          role: list.data.role,
          targetType: list.data.targetType,
          targetId: list.data.targetId,
          ...(list.data.offeringId ? { offeringId: list.data.offeringId } : {}),
          engagement: 'regular',
          offer: true,
        },
      });
      toast.show({
        tone: 'success',
        message: `Asked ${c.displayName}. The shift is covered once they accept.`,
      });
      onAsked();
    } catch (error) {
      const code = (error as { code?: string }).code;
      toast.show({
        tone: 'error',
        message: `The offer didn't send.${code ? ` Code ${code}` : ''}`,
      });
    } finally {
      setAsking(null);
    }
  };
  const sorted = [...(list.data?.candidates ?? [])].sort(
    (a, b) => Number(b.eligible) - Number(a.eligible) || a.displayName.localeCompare(b.displayName),
  );
  return (
    <Drawer
      open={shift !== null}
      onClose={onClose}
      labelledBy="open-shift-title"
      header={
        <h2 id="open-shift-title" className="team-drawer-title">
          {shift ? `${shift.title}: ${ROLE_WORD[toneOf(shift.kind)]} needed` : ''}
        </h2>
      }
    >
      {shift ? (
        <div className="team-drawer">
          <p className="team-kicker">
            {new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(
              new Date(shift.start),
            )}{' '}
            {shift.end ? hourRange(shift.start, shift.end, tz) : ''} · who&apos;s free and qualified
          </p>
          {list.error ? (
            <StateView variant="error" error={list.error} onRetry={() => void list.refetch()} />
          ) : !list.data ? (
            <Skeleton height={120} />
          ) : sorted.length === 0 ? (
            <StateView
              variant="empty"
              title="Nobody to ask"
              description="No one holds the role or the qualifications this slot needs."
            />
          ) : (
            <ul className="team-candidates">
              {sorted.map((c) => (
                <li key={c.personId} data-eligible={c.eligible || undefined}>
                  <Avatar name={c.displayName} personKey={c.personId} size={34} decorative />
                  <span className="team-candidate-text">
                    <b>{c.displayName}</b>
                    <small>
                      {c.eligible
                        ? '✓ Free and qualified'
                        : `✕ ${c.reasons.find((r) => r.severity === 'blocking')?.message ?? 'Not available'}`}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="team-primary"
                    disabled={!online || !c.eligible || asking !== null}
                    onClick={() => void ask(c)}
                  >
                    {asking === c.personId ? 'Asking…' : 'Ask'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Drawer>
  );
}
