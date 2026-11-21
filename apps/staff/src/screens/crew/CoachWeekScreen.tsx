/**
 * Coach · My week (staff redesign Phase 8 item 1; SPK-UX-007 field-side work, SPK-CAP-001 captain
 * tools, SPK-CAP-003 availability). The coach's home tab (Week · Teams · Now · Messages · More):
 *
 * - "Needs you": players who have not answered for the next game, with Nudge (`POST
 *   /v1/fixtures/{id}/availability-requests`, which reaches only those without an answer), a
 *   played game whose score is not confirmed yet (the coach's game log without the official
 *   result, `GET /v1/fixtures/{id}/lineup`), a game played without a score, and offers to answer;
 * - a night card for the next session: the countdown pill, going / no answer / allergies, Lineup
 *   and Start game day for a game, Attendance and Pickup for a class;
 * - the rest of today as rows, then day chips for the week (a chip lists that day).
 *
 * Reads come from the existing workspace and team reads (coach-model.ts); nothing is decided here
 * that the API did not say. Allergies are not counted: care notes are readable by the desk and the
 * managers only (identity.read_care_notes), so the tile says where they are shown (Pending
 * decision: coach access to care flags). Offline, Nudge is disabled with its reason.
 */
import type { Schema } from '@sportspark/api-client';
import { apiQueryKey } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi, useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StatusBadge } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import {
  captainedEntries,
  dayChipOf,
  nextItem,
  weekDays,
  weekItems,
  type WeekItem,
} from './coach-model';
import { clockOf, countdownText, CrewHero, dayLabelOf, localDayOf } from './crew-ui';
import './crew.css';

type TeamSheet = Schema<'TeamSheet'>;

const DAY = 86_400_000;

export function lineupPath(fixtureId: string, teamEntryId?: string): string {
  return `/workspace/fixtures/${fixtureId}/lineup${teamEntryId ? `?team=${teamEntryId}` : ''}`;
}
export function gameDayPath(fixtureId: string, teamEntryId?: string): string {
  return `/workspace/fixtures/${fixtureId}/game-day${teamEntryId ? `?team=${teamEntryId}` : ''}`;
}

function NudgeRow({ item }: { item: WeekItem }) {
  const { online } = useApp();
  const toast = useToast();
  const nudge = useApiCommand('post', '/fixtures/{id}/availability-requests', {
    invalidate: [['api', '/me/fixtures']],
  });
  const missing = item.availability?.noResponse ?? 0;
  const reasonId = useId();
  const send = () => {
    if (!online || !item.fixtureId || !item.teamEntryId) return;
    void nudge
      .submit({
        path: { id: item.fixtureId },
        body: { teamEntryId: item.teamEntryId },
      })
      .then((res) => {
        const n = res.recipientCount;
        toast.show({
          tone: 'success',
          message:
            n === 0
              ? 'Everyone has answered now'
              : `Asked the ${n} ${n === 1 ? 'player' : 'players'} without an answer`,
        });
      })
      .catch(() => toast.show({ tone: 'error', message: 'The nudge was not sent. Try again.' }));
  };
  return (
    <li>
      <div className="crew-row">
        <StatusBadge tone="warning" label="No answer" size="sm" />
        <div className="crew-row-text">
          <span className="crew-row-title">
            {missing} {missing === 1 ? "hasn't" : "haven't"} answered for {item.title}
          </span>
          <span className="crew-meta">
            {dayLabelOf(item.start, item.timezone)} · {clockOf(item.start, item.timezone)}
          </span>
        </div>
        <Button
          variant="secondary"
          className="button-sm"
          busy={nudge.isProcessing}
          disabled={!online}
          aria-describedby={online ? undefined : reasonId}
          onClick={send}
        >
          Nudge
        </Button>
        {online ? null : (
          <span id={reasonId} className="visually-hidden">
            Needs a connection
          </span>
        )}
      </div>
    </li>
  );
}

function ResultRow({ item, sheet }: { item: WeekItem; sheet: TeamSheet }) {
  const log = sheet.gameLog;
  if (log) {
    return (
      <li>
        <div className="crew-row">
          <StatusBadge tone="pending" label="Not confirmed" size="sm" />
          <div className="crew-row-text">
            <span className="crew-row-title">
              {sheet.side === 'home' ? sheet.teamName : sheet.opponentName} {log.homeScore}–
              {log.awayScore} {sheet.side === 'home' ? sheet.opponentName : sheet.teamName}
            </span>
            <span className="crew-meta">
              Waiting for the referee&apos;s report. Families see the score once it matches.
            </span>
          </div>
        </div>
      </li>
    );
  }
  return (
    <li>
      <div className="crew-row">
        <StatusBadge tone="warning" label="No score" size="sm" />
        <div className="crew-row-text">
          <span className="crew-row-title">Record the score of {item.title}</span>
          <span className="crew-meta">{dayLabelOf(item.start, item.timezone)}</span>
        </div>
        <Link
          className="button button-secondary button-sm"
          to={gameDayPath(item.fixtureId!, item.teamEntryId)}
        >
          Record
        </Link>
      </div>
    </li>
  );
}

interface NeedsYouRows {
  /** The next game, when players have not answered for it. */
  nudges: WeekItem[];
  /** Played games without the official result: the coach's score waits, or no score was kept. */
  unconfirmed: WeekItem[];
  offers: number;
  count: number;
}

/** What "Needs you" lists (and the header counts). */
export function needsYouOf(
  items: readonly WeekItem[],
  sheets: ReadonlyMap<string, TeamSheet>,
  offers: number,
  now: Date,
): NeedsYouRows {
  const t = now.getTime();
  const nextGame = items.find((i) => i.kind === 'game' && new Date(i.end).getTime() > t);
  const nudges = nextGame && (nextGame.availability?.noResponse ?? 0) > 0 ? [nextGame] : [];
  const unconfirmed = items.filter((i) => {
    if (i.kind !== 'game' || new Date(i.end).getTime() > t) return false;
    const sheet = sheets.get(i.fixtureId!);
    if (!sheet || sheet.officialResult) return false;
    return sheet.gameLog !== null || sheet.availableActions.includes('record_game_log');
  });
  return {
    nudges,
    unconfirmed,
    offers,
    count: nudges.length + unconfirmed.length + (offers > 0 ? 1 : 0),
  };
}

function NeedsYou({
  rows,
  sheets,
}: {
  rows: NeedsYouRows;
  sheets: ReadonlyMap<string, TeamSheet>;
}) {
  const { nudges, unconfirmed, offers, count } = rows;
  if (count === 0) return null;
  return (
    <section className="crew-card" data-edge="warning" aria-labelledby="needs-you-title">
      <div className="crew-card-head">
        <h3 id="needs-you-title">Needs you</h3>
        <span className="crew-meta">{count}</span>
      </div>
      <ul className="crew-list">
        {nudges.map((item) => (
          <NudgeRow key={item.id} item={item} />
        ))}
        {unconfirmed.map((item) => (
          <ResultRow key={item.id} item={item} sheet={sheets.get(item.fixtureId!)!} />
        ))}
        {offers > 0 ? (
          <li>
            <div className="crew-row">
              <StatusBadge tone="pending" label="Offered" size="sm" />
              <div className="crew-row-text">
                <span className="crew-row-title">
                  {offers} {offers === 1 ? 'assignment waits' : 'assignments wait'} for your answer
                </span>
              </div>
              <Link className="button button-secondary button-sm" to="/workspace">
                Answer
              </Link>
            </div>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function NextCard({
  item,
  sheet,
  now,
}: {
  item: WeekItem;
  sheet: TeamSheet | undefined;
  now: Date;
}) {
  const titleId = useId();
  const live = new Date(item.start).getTime() <= now.getTime();
  const going = item.availability?.available ?? 0;
  const noAnswer = item.availability?.noResponse ?? 0;
  return (
    <section className="crew-card crew-night" aria-labelledby={titleId}>
      <span className="crew-pill" data-testid="countdown">
        {live ? <span className="live-dot" aria-hidden="true" /> : null}
        {countdownText(item.start, item.end, now)}
      </span>
      <h3 id={titleId}>{item.title}</h3>
      <p className="crew-meta">
        {dayLabelOf(item.start, item.timezone)} · {clockOf(item.start, item.timezone)}–
        {clockOf(item.end, item.timezone)}
        {item.place ? ` · ${item.place}` : ''}
      </p>
      {item.kind === 'game' ? (
        <>
          <div className="crew-stats">
            <div className="crew-stat">
              <strong>{going}</strong>
              <span>Going</span>
            </div>
            <div className="crew-stat" data-tone={noAnswer > 0 ? 'warning' : undefined}>
              <strong>{noAnswer}</strong>
              <span>No answer</span>
            </div>
            <div className="crew-stat" data-tone="pending">
              <strong>
                <span aria-hidden="true">◷ </span>At check-in
              </strong>
              <span>Allergies</span>
            </div>
          </div>
          {sheet?.lineup ? (
            <p className="crew-meta">
              {sheet.lineup.sharedAt
                ? `Lineup shared${sheet.lineup.changedSinceShared ? ', changed since' : ''}`
                : 'Lineup saved, not shared yet'}
            </p>
          ) : null}
          <div className="crew-actions">
            <Link
              className="button button-secondary"
              to={lineupPath(item.fixtureId!, item.teamEntryId)}
            >
              <Icon name="sports_soccer" size={18} />
              Lineup
            </Link>
            <Link
              className="button button-lime"
              to={gameDayPath(item.fixtureId!, item.teamEntryId)}
            >
              <Icon name="play_arrow" size={18} />
              Start game day
            </Link>
          </div>
        </>
      ) : (
        <div className="crew-actions">
          <Link
            className="button button-secondary"
            to={`/workspace/assignments/${item.assignmentId}/attendance`}
          >
            <Icon name="how_to_reg" size={18} />
            Attendance
          </Link>
          <Link
            className="button button-lime"
            to={`/workspace/assignments/${item.assignmentId}/release`}
          >
            <Icon name="family_restroom" size={18} />
            Pickup
          </Link>
        </div>
      )}
    </section>
  );
}

function ItemRow({ item }: { item: WeekItem }) {
  const href =
    item.kind === 'game'
      ? lineupPath(item.fixtureId!, item.teamEntryId)
      : `/workspace/assignments/${item.assignmentId}`;
  return (
    <li>
      <div className="crew-row">
        <span className="crew-time">{clockOf(item.start, item.timezone)}</span>
        <div className="crew-row-text">
          <Link className="crew-row-title" to={href}>
            {item.title}
          </Link>
          <span className="crew-meta">
            {item.kind === 'game'
              ? `Game${item.availability ? ` · ${item.availability.available} going` : ''}`
              : 'Class'}
            {item.place ? ` · ${item.place}` : ''}
          </span>
        </div>
        {item.assignmentStatus === 'offered' ? (
          <StatusBadge tone="pending" label="Offered" size="sm" />
        ) : null}
      </div>
    </li>
  );
}

function WeekSkeleton() {
  return (
    <SkeletonGroup label="your week" className="crew">
      <Skeleton height={120} radius={20} />
      <Skeleton height={220} radius={20} />
      <Skeleton height={64} radius={16} />
    </SkeletonGroup>
  );
}

export function CoachWeekScreen() {
  const now = useNow(30_000);
  const api = useApi();
  const { session } = useApp();
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const assignments = useApiQuery({ path: '/me/assignments' });
  const entries = useApiQuery({ path: '/me/team-entries' });
  // From two weeks back (results waiting for confirmation) to the end of next week.
  const window = useMemo(() => {
    const day = Math.floor(now.getTime() / DAY) * DAY;
    return {
      from: new Date(day - 14 * DAY).toISOString(),
      to: new Date(day + 9 * DAY).toISOString(),
    };
  }, [now]);
  const fixtures = useApiQuery({ path: '/me/fixtures', request: { query: window } });
  const captained = useMemo(
    () => captainedEntries(entries.data ?? [], me.data?.principal.personId ?? null),
    [entries.data, me.data],
  );
  const items = useMemo(
    () => weekItems(assignments.data?.items ?? [], fixtures.data ?? [], captained),
    [assignments.data, fixtures.data, captained],
  );
  const timezone = items.find((i) => i.timezone)?.timezone ?? null;
  const t = now.getTime();
  // Team sheets of the next game and of the games played in the last fortnight.
  const sheetFor = items.filter(
    (i) =>
      i.kind === 'game' &&
      (new Date(i.end).getTime() <= t ||
        i.id === items.find((x) => x.kind === 'game' && new Date(x.end).getTime() > t)?.id),
  );
  const sheetReads = useQueries({
    queries: sheetFor.map((i) => {
      const request = { path: { id: i.fixtureId! }, query: { teamEntryId: i.teamEntryId } };
      return {
        queryKey: apiQueryKey('/fixtures/{id}/lineup', request),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await api.request('get', '/fixtures/{id}/lineup', { ...request, signal })).data,
        staleTime: 30_000,
      };
    }),
  });
  const sheets = new Map<string, TeamSheet>();
  sheetFor.forEach((i, index) => {
    const data = sheetReads[index]?.data as TeamSheet | undefined;
    if (data) sheets.set(i.fixtureId!, data);
  });

  const today = localDayOf(now, timezone);
  const days = weekDays(now, timezone);
  const [selected, setSelected] = useState<string | null>(null);
  const day = selected ?? today;
  const next = nextItem(items, now);
  const restOfToday = items.filter(
    (i) =>
      localDayOf(i.start, i.timezone) === today &&
      i.id !== next?.id &&
      new Date(i.end).getTime() > t,
  );
  const dayItems = items.filter((i) => localDayOf(i.start, i.timezone) === day);
  const offers = (assignments.data?.items ?? []).filter(
    (a) => a.assignment.status === 'offered',
  ).length;
  const needs = needsYouOf(items, sheets, offers, now);
  const needCount = needs.count;

  return (
    <section aria-labelledby="coach-week-title" className="crew ops-screen">
      <CrewHero
        titleId="coach-week-title"
        kicker={`${dayLabelOf(now, timezone)}${needCount > 0 ? ` · ${needCount} need you` : ''}`}
        title="My week"
      />
      <QueryBoundary
        query={assignments}
        label="your week"
        loading={<WeekSkeleton />}
        empty={{ title: '', description: '' }}
        unavailableOffline={['nudging players']}
      >
        {() => (
          <>
            <NeedsYou rows={needs} sheets={sheets} />
            {next ? (
              <NextCard item={next} sheet={sheets.get(next.fixtureId ?? '')} now={now} />
            ) : (
              <section className="crew-card">
                <p className="crew-empty">
                  Nothing else this week. Games of the teams you coach and the classes you are
                  assigned to appear here.
                </p>
              </section>
            )}
            {restOfToday.length > 0 ? (
              <section className="crew-card" aria-labelledby="rest-today-title">
                <h3 id="rest-today-title">Later today</h3>
                <ul className="crew-list">
                  {restOfToday.map((item) => (
                    <ItemRow key={item.id} item={item} />
                  ))}
                </ul>
              </section>
            ) : null}
            <h3 className="crew-section-title" id="week-days-title">
              This week
            </h3>
            <div className="crew-days" role="group" aria-labelledby="week-days-title">
              {days.map((d) => {
                const chip = dayChipOf(d);
                const n = items.filter((i) => localDayOf(i.start, i.timezone) === d).length;
                return (
                  <button
                    key={d}
                    type="button"
                    className="crew-day"
                    aria-pressed={d === day}
                    aria-label={`${chip.weekday} ${chip.date}: ${n} ${n === 1 ? 'activity' : 'activities'}`}
                    onClick={() => setSelected(d)}
                  >
                    <small>{d === today ? 'Today' : chip.weekday}</small>
                    <b>{chip.date}</b>
                    <i>{n > 0 ? `${n}` : '–'}</i>
                  </button>
                );
              })}
            </div>
            {day !== today ? (
              <section className="crew-card" aria-label={`Activities on ${day}`}>
                {dayItems.length === 0 ? (
                  <p className="crew-empty">Nothing on this day.</p>
                ) : (
                  <ul className="crew-list">
                    {dayItems.map((item) => (
                      <ItemRow key={item.id} item={item} />
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
