/**
 * Coach · Live game day (staff redesign Phase 8 item 3, night; SPK-UX-007 field-side work,
 * SPK-RESULT-001 result reporting). A big ± score per team, the timeline (a goal with its scorer
 * and assist, a substitution, the opponent's goal, half time), Sub / Half time / Injury and
 * "End game · 3–1".
 *
 * - The game lives on this phone while it is played (game-day-model.ts, stored in this browser's
 *   preferences with identifiers and minutes only), so a lost connection loses nothing.
 * - Our "+" asks who scored and who assisted (or "Not sure" / "No assist"); the opponent's "+"
 *   records their goal; "−" takes the latest goal of that side off. Each change offers Undo.
 * - Injury opens the injury report (the coach workspace's Issues tab, `INJURY_REPORT_PATH`) with
 *   the game and the player.
 * - "End game" sends the side's game log with every player's minutes (`POST
 *   /v1/fixtures/{id}/game-log`). Offline it waits on this phone and is sent once the connection is
 *   back (the same request, the same idempotency key). The game log is never the result: the
 *   score posts to families once the league publishes the referee's report, and the referee's
 *   report is checked against this score (SPK-RESULT-001/002).
 */
import type { Schema } from '@sportspark/api-client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useNow } from '../../providers/AppProviders';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StatusBadge } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { clockOf, CrewHero } from './crew-ui';
import {
  goalsOf,
  minuteOf,
  minutesPlayed,
  newGame,
  onPitchOf,
  parseGame,
  phaseOf,
  scoreOf,
  withoutLastGoal,
  type GameLogEvent,
  type GameState,
} from './game-day-model';
import {
  autoFillFairly,
  DEFAULT_FORMATION,
  goingPlayers,
  shortName,
  slotsOf,
} from './lineup-model';
import './crew.css';

type TeamSheet = Schema<'TeamSheet'>;

/** The injury report (S 4d, the coach workspace's Issues tab); it reads `fixtureId` and `personId`. */
/** The coach's injury report (staff S 4d, the workspace Issues flow). */
export const INJURY_REPORT_PATH = '/workspace/issues';

const storageKey = (fixtureId: string, teamEntryId: string) =>
  `sportspark.gameday.${fixtureId}.${teamEntryId}`;

function startersOf(sheet: TeamSheet): string[] {
  if (sheet.lineup && sheet.lineup.slots.length > 0) {
    return sheet.lineup.slots.map((s) => s.personId);
  }
  return slotsOf(autoFillFairly(sheet.players, {}, DEFAULT_FORMATION), DEFAULT_FORMATION).map(
    (s) => s.personId,
  );
}

type Sheet =
  | { kind: 'scorer' }
  | { kind: 'assist'; scorer: string | null }
  | { kind: 'sub-off' }
  | { kind: 'sub-on'; off: string }
  | null;

function EventText({ event, name }: { event: GameLogEvent; name: (id: string | null) => string }) {
  switch (event.kind) {
    case 'goal':
      return (
        <>
          <Icon name="sports_soccer" size={18} /> Goal · {name(event.personId)}
          {event.assistPersonId ? ` (assist ${name(event.assistPersonId)})` : ''}
        </>
      );
    case 'opponent_goal':
      return <>Opponent goal</>;
    case 'substitution':
      return (
        <>
          <Icon name="swap_horiz" size={18} /> Sub · {name(event.onPersonId)} on,{' '}
          {name(event.offPersonId)} off
        </>
      );
    case 'half_time':
      return <>Half time</>;
  }
}

function Live({ sheet }: { sheet: TeamSheet }) {
  const { online, preferences } = useApp();
  const toast = useToast();
  const now = useNow(15_000);
  const key = storageKey(sheet.fixtureId, sheet.teamEntryId);
  const [game, setGame] = useState<GameState>(
    () => parseGame(preferences.get(key)) ?? newGame(startersOf(sheet)),
  );
  const [sheetOpen, setSheetOpen] = useState<Sheet>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const endTitle = useId();
  const sheetTitle = useId();
  const save = useCallback(
    (next: GameState) => {
      setGame(next);
      preferences.set(key, JSON.stringify(next));
    },
    [key, preferences],
  );
  const send = useApiCommand('post', '/fixtures/{id}/game-log', {
    invalidate: [
      ['api', '/fixtures/{id}/lineup'],
      ['api', '/me/fixtures'],
    ],
  });
  const byId = useMemo(() => new Map(sheet.players.map((p) => [p.personId, p])), [sheet.players]);
  const name = (id: string | null) =>
    id ? shortName(byId.get(id)?.displayName ?? 'Player') : 'Not sure';
  const minute = minuteOf(game, now);
  const phase = phaseOf(game);
  const onPitch = onPitchOf(game);
  const bench = goingPlayers(sheet.players).filter((p) => !onPitch.includes(p.personId));
  const score = scoreOf(game, sheet.side);
  const { ours, theirs } = goalsOf(game);
  const ourName = sheet.teamName;
  const theirName = sheet.opponentName ?? 'Opponent';
  const homeName = sheet.side === 'home' ? ourName : theirName;
  const awayName = sheet.side === 'home' ? theirName : ourName;
  const canRecord = sheet.availableActions.includes('record_game_log');

  const change = (next: GameState, message: string) => {
    const before = game;
    save(next);
    toast.show({ message, onUndo: () => save(before) });
  };
  const addEvent = (event: GameLogEvent, message: string) =>
    change({ ...game, events: [...game.events, event] }, message);

  const body = (state: GameState) => {
    const s = scoreOf(state, sheet.side);
    return {
      teamEntryId: sheet.teamEntryId,
      homeScore: s.home,
      awayScore: s.away,
      events: state.events,
      minutes: minutesPlayed(state, minuteOf(state, now)),
      ...(sheet.gameLog ? { expectedRevision: sheet.gameLog.revision } : {}),
    };
  };
  const sending = useRef(false);
  const trySend = useCallback(
    async (state: GameState) => {
      if (sending.current) return;
      sending.current = true;
      try {
        await send.submit({ path: { id: sheet.fixtureId }, body: body(state) });
        const done = { ...state, pendingSend: false };
        setGame(done);
        preferences.set(key, null);
        toast.show({
          tone: 'success',
          message: 'Score sent. Families see it once it matches the referee’s report.',
        });
      } catch {
        toast.show({
          tone: 'error',
          message: 'The score did not send. It is kept on this phone; try again.',
          action: { label: 'Try again', onClick: () => void trySend(state) },
        });
      } finally {
        sending.current = false;
      }
    },
    // body reads the sheet and the clock; the state is passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, sheet.fixtureId, key, preferences],
  );
  // A score that waited for a connection is sent once it is back.
  useEffect(() => {
    if (online && game.pendingSend && !send.isProcessing) void trySend(game);
  }, [online, game, send.isProcessing, trySend]);

  const endGame = () => {
    setConfirmEnd(false);
    const ended = { ...game, endedAt: now.toISOString(), pendingSend: true };
    save(ended);
    if (online) void trySend(ended);
  };

  // The game already has a log on the server and nothing waits here: the summary.
  if (sheet.gameLog && !game.startedAt) {
    const log = sheet.gameLog;
    return (
      <div className="crew-body">
        <section className="gameday" aria-label="Final score">
          <div className="gd-score">
            <div className="gd-team">
              <span className="gd-team-name">{homeName}</span>
              <span className="gd-number">{log.homeScore}</span>
            </div>
            <span className="gd-dash">–</span>
            <div className="gd-team">
              <span className="gd-team-name">{awayName}</span>
              <span className="gd-number">{log.awayScore}</span>
            </div>
          </div>
          <ResultCheck sheet={sheet} />
          <ol className="gd-timeline" aria-label="Timeline">
            {[...log.events].reverse().map((e, i) => (
              <li key={i} className="gd-event" data-kind={e.kind}>
                <span className="gd-minute">{e.minute}&apos;</span>
                <span>
                  <EventText event={e} name={name} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    );
  }

  return (
    <div className="crew-body">
      <section className="gameday" aria-label="Live score">
        <div className="gd-clock" role="timer" aria-live="off">
          {phase === 'before' ? (
            <span>
              Kick-off {sheet.scheduledStart ? clockOf(sheet.scheduledStart, sheet.timezone) : ''}
            </span>
          ) : phase === 'half_time' ? (
            <StatusBadge tone="neutral" label={`Half time · ${minute}'`} size="sm" />
          ) : phase === 'ended' ? (
            <StatusBadge tone="success" label={`Full time · ${minute}'`} size="sm" />
          ) : (
            <span className="crew-pill">
              <span className="live-dot" aria-hidden="true" />
              Live · {minute}&apos;
            </span>
          )}
        </div>
        <div className="gd-score">
          {(['home', 'away'] as const).map((side, i) => {
            const isOurs = side === sheet.side;
            const value = side === 'home' ? score.home : score.away;
            const label = side === 'home' ? homeName : awayName;
            const disabled = phase === 'before' || phase === 'ended';
            return (
              <div key={side} className="gd-team" style={{ order: i === 0 ? 0 : 2 }}>
                <span className="gd-team-name">{label}</span>
                <span className="gd-number" aria-label={`${label} ${value}`}>
                  {value}
                </span>
                <div className="gd-buttons">
                  <button
                    type="button"
                    className="gd-round"
                    aria-label={`Take a goal off ${label}`}
                    disabled={disabled || (isOurs ? ours : theirs) === 0}
                    onClick={() => {
                      const next = withoutLastGoal(game, isOurs);
                      if (next) change(next, `Goal taken off ${label}`);
                    }}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="gd-round"
                    data-primary="true"
                    aria-label={`Goal for ${label}`}
                    disabled={disabled}
                    onClick={() =>
                      isOurs
                        ? setSheetOpen({ kind: 'scorer' })
                        : addEvent({ kind: 'opponent_goal', minute }, `${label} goal · ${minute}'`)
                    }
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
          <span className="gd-dash" style={{ order: 1 }} aria-hidden="true">
            –
          </span>
        </div>

        {phase === 'before' ? (
          <Button
            className="button-lime gd-end"
            onClick={() => save({ ...game, startedAt: now.toISOString() })}
            disabled={!canRecord}
          >
            <Icon name="play_arrow" size={20} /> Kick off
          </Button>
        ) : null}

        {phase !== 'before' ? (
          <div className="gd-tools">
            <button
              type="button"
              className="gd-tool"
              disabled={phase === 'ended' || bench.length === 0}
              onClick={() => setSheetOpen({ kind: 'sub-off' })}
            >
              <Icon name="swap_horiz" size={22} />
              Sub
            </button>
            <button
              type="button"
              className="gd-tool"
              disabled={phase === 'ended'}
              onClick={() => {
                if (phase === 'first') {
                  change(
                    {
                      ...game,
                      halfTimeAt: now.toISOString(),
                      events: [...game.events, { kind: 'half_time', minute }],
                    },
                    `Half time · ${minute}'`,
                  );
                } else if (phase === 'half_time') {
                  save({ ...game, secondHalfAt: now.toISOString() });
                }
              }}
            >
              <Icon name={phase === 'half_time' ? 'play_arrow' : 'pause'} size={22} />
              {phase === 'half_time' ? 'Second half' : 'Half time'}
            </button>
            <Link
              className="gd-tool"
              to={`${INJURY_REPORT_PATH}?fixtureId=${sheet.fixtureId}&injury=1`}
            >
              <Icon name="personal_injury" size={22} />
              Injury
            </Link>
          </div>
        ) : null}

        <ol className="gd-timeline" aria-label="Timeline">
          {game.events.length === 0 ? (
            <li className="gd-event">
              <span className="gd-minute">–</span>
              <span>
                {phase === 'before' ? 'The timeline starts at kick-off.' : 'No goals yet.'}
              </span>
            </li>
          ) : (
            [...game.events].reverse().map((e, i) => (
              <li key={game.events.length - i} className="gd-event" data-kind={e.kind}>
                <span className="gd-minute">{e.minute}&apos;</span>
                <span>
                  <EventText event={e} name={name} />
                </span>
              </li>
            ))
          )}
        </ol>

        {phase === 'ended' ? (
          game.pendingSend ? (
            <p className="crew-note" data-tone="warning">
              {online
                ? 'Sending the score…'
                : 'Saved on this phone. The score is sent once the connection is back.'}
            </p>
          ) : (
            <ResultCheck sheet={sheet} />
          )
        ) : phase !== 'before' ? (
          <Button
            className="button-lime gd-end"
            onClick={() => setConfirmEnd(true)}
            disabled={!canRecord}
          >
            End game · {score.home}–{score.away}
          </Button>
        ) : null}
      </section>

      <BottomSheet
        open={sheetOpen !== null}
        onClose={() => setSheetOpen(null)}
        titleId={sheetTitle}
        title={
          sheetOpen?.kind === 'scorer'
            ? `Who scored for ${ourName}?`
            : sheetOpen?.kind === 'assist'
              ? 'Who assisted?'
              : sheetOpen?.kind === 'sub-off'
                ? 'Who comes off?'
                : 'Who goes on?'
        }
      >
        <div className="gd-pick">
          {sheetOpen?.kind === 'scorer' || sheetOpen?.kind === 'sub-off'
            ? onPitch.map((p) => (
                <Button
                  key={p}
                  variant="secondary"
                  onClick={() =>
                    setSheetOpen(
                      sheetOpen.kind === 'scorer'
                        ? { kind: 'assist', scorer: p }
                        : { kind: 'sub-on', off: p },
                    )
                  }
                >
                  {name(p)}
                </Button>
              ))
            : null}
          {sheetOpen?.kind === 'assist'
            ? onPitch
                .filter((p) => p !== sheetOpen.scorer)
                .map((p) => (
                  <Button
                    key={p}
                    variant="secondary"
                    onClick={() => {
                      setSheetOpen(null);
                      addEvent(
                        { kind: 'goal', minute, personId: sheetOpen.scorer, assistPersonId: p },
                        `Goal · ${name(sheetOpen.scorer)} (assist ${name(p)})`,
                      );
                    }}
                  >
                    {name(p)}
                  </Button>
                ))
            : null}
          {sheetOpen?.kind === 'sub-on'
            ? bench.map((p) => (
                <Button
                  key={p.personId}
                  variant="secondary"
                  onClick={() => {
                    setSheetOpen(null);
                    addEvent(
                      {
                        kind: 'substitution',
                        minute,
                        offPersonId: sheetOpen.off,
                        onPersonId: p.personId,
                      },
                      `Sub · ${name(p.personId)} on, ${name(sheetOpen.off)} off`,
                    );
                  }}
                >
                  {name(p.personId)}
                </Button>
              ))
            : null}
        </div>
        {sheetOpen?.kind === 'scorer' ? (
          <Button
            variant="secondary"
            onClick={() => setSheetOpen({ kind: 'assist', scorer: null })}
          >
            Not sure
          </Button>
        ) : null}
        {sheetOpen?.kind === 'assist' ? (
          <Button
            onClick={() => {
              const scorer = sheetOpen.scorer;
              setSheetOpen(null);
              addEvent(
                { kind: 'goal', minute, personId: scorer, assistPersonId: null },
                `Goal · ${name(scorer)}`,
              );
            }}
          >
            No assist
          </Button>
        ) : null}
      </BottomSheet>

      {confirmEnd ? (
        <Dialog
          labelledBy={endTitle}
          onClose={() => setConfirmEnd(false)}
          header={
            <h2 id={endTitle}>
              End game · {score.home}–{score.away}?
            </h2>
          }
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
                Keep playing
              </Button>
              <Button onClick={endGame}>End game</Button>
            </>
          }
        >
          <p>
            {homeName} {score.home}–{score.away} {awayName}. The score and every player&apos;s
            minutes go to the referee&apos;s match check; families see the score once it matches the
            referee&apos;s report.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

/** After the game: whether the referee's report agrees (the official result once published). */
function ResultCheck({ sheet }: { sheet: TeamSheet }) {
  const official = sheet.officialResult;
  if (!official) {
    return (
      <p className="crew-note" data-tone="info">
        Sent. Waiting for the referee&apos;s report: families see the score once it matches.
      </p>
    );
  }
  return official.matchesGameLog === false ? (
    <p className="crew-note" data-tone="warning">
      ▲ The referee reported {official.homeScore}–{official.awayScore}. The league checks the
      difference.
    </p>
  ) : (
    <p className="crew-note" data-tone="success">
      ✓ Matches the referee&apos;s report. Families can see the score.
    </p>
  );
}

export function GameDayScreen() {
  const { fixtureId = '' } = useParams();
  const [search] = useSearchParams();
  const team = search.get('team') ?? undefined;
  const sheet = useApiQuery({
    path: '/fixtures/{id}/lineup',
    request: { path: { id: fixtureId }, query: team ? { teamEntryId: team } : {} },
  });
  const data = sheet.data;
  return (
    <section aria-labelledby="gameday-title" className="crew ops-screen">
      <CrewHero
        titleId="gameday-title"
        back={{ to: '/workspace/week', label: 'My week' }}
        kicker={data?.venueName ?? 'Game day'}
        title={data ? `${data.teamName} vs ${data.opponentName ?? 'bye'}` : 'Game day'}
      />
      <QueryBoundary
        query={sheet}
        label="the game"
        loading={
          <SkeletonGroup label="the game" className="crew">
            <Skeleton height={260} radius={24} />
            <Skeleton height={120} radius={20} />
          </SkeletonGroup>
        }
        empty={{ title: '', description: '' }}
        unavailableOffline={['sending the score (it is kept on this phone)']}
      >
        {(d) => <Live key={`${d.fixtureId}:${d.teamEntryId}`} sheet={d} />}
      </QueryBoundary>
    </section>
  );
}
