/**
 * Coach · Lineup (staff redesign Phase 8 item 2; SPK-CAP-001 captain tools, SPK-CAP-003
 * availability, SPK-UX-009 a keyboard path for every drag). A pitch with the players in formation
 * (photo, or initials on the person colour) and the bench: only players who answered Going, the
 * fewest minutes this season first, ▲ amber below the team average (`GET /v1/fixtures/{id}/lineup`,
 * minutes from the coach's game logs, competition migration 0475).
 *
 * - Drag a player onto a place to put them there or to swap with whoever stands there; drag a
 *   place back to the bench to empty it. Pointer, touch and pen alike; the dragged player follows
 *   the finger (no tilt with reduced motion).
 * - Without dragging (keyboard, or tap and tap): choose a player (Enter / Space / tap), then the
 *   place or the bench; Escape lets go. Each move is announced.
 * - "Auto-fill fairly" keeps the goalkeeper and gives the other places to the Going players with
 *   the fewest minutes.
 * - Save (`POST /v1/fixtures/{id}/lineup`, with the revision) with Undo for 5 s; Share
 *   (`POST /v1/fixtures/{id}/lineup/share`) saves first when needed. Sharing is recorded and
 *   announced as `competition.lineup_shared`; the families' notice goes out once messaging
 *   delivers it (Pending decision 8, a messaging API), which the screen says.
 * - Offline the lineup can still be arranged; Save and Share are disabled with the reason.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { SegmentedControl } from '../../ui/SegmentedControl';
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';
import { StatusBadge } from '../../ui/StatusBadge';
import { useToast } from '../../ui/Toast';
import { clockOf, CrewHero, dayLabelOf, ProposedTag } from './crew-ui';
import {
  autoFillFairly,
  belowAverage,
  benchOf,
  DEFAULT_FORMATION,
  FORMATIONS,
  goingPlayers,
  placeName,
  placementOf,
  placeOrSwap,
  placesOf,
  rowsOf,
  samePlacement,
  shortName,
  slotsOf,
  type Placement,
  type Spot,
  type TeamSheetPlayer,
} from './lineup-model';
import './crew.css';

type TeamSheet = Schema<'TeamSheet'>;

const DRAG_THRESHOLD_PX = 6;

function spotKey(s: Spot): string {
  return s.kind === 'slot' ? `slot:${s.slot}` : `bench:${s.personId}`;
}

function spotFromElement(el: Element | null): Spot | null {
  const target = el?.closest<HTMLElement>('[data-drop]');
  if (!target) return null;
  const drop = target.dataset['drop'] ?? '';
  if (drop.startsWith('slot:')) return { kind: 'slot', slot: Number(drop.slice(5)) };
  if (drop === 'bench') return { kind: 'bench', personId: '' };
  if (drop.startsWith('bench:')) return { kind: 'bench', personId: drop.slice(6) };
  return null;
}

interface DragState {
  from: Spot;
  personId: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
}

function Editor({ sheet }: { sheet: TeamSheet }) {
  const { online } = useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const offlineId = useId();
  const live = useRef<HTMLParagraphElement>(null);
  const saved = sheet.lineup;
  const [formation, setFormation] = useState(saved?.formation ?? DEFAULT_FORMATION);
  const [placement, setPlacement] = useState<Placement>(() =>
    saved ? placementOf(saved.slots) : {},
  );
  const [picked, setPicked] = useState<Spot | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [message, setMessage] = useState('');
  const byId = useMemo(() => new Map(sheet.players.map((p) => [p.personId, p])), [sheet.players]);
  const bench = benchOf(sheet.players, placement);
  const going = goingPlayers(sheet.players);
  const places = placesOf(formation);
  const dirty =
    !saved || saved.formation !== formation || !samePlacement(placementOf(saved.slots), placement);
  const canSave = sheet.availableActions.includes('save_lineup');
  const invalidate = [['api', '/fixtures/{id}/lineup']] as const;
  const save = useApiCommand('post', '/fixtures/{id}/lineup', { invalidate });
  const share = useApiCommand('post', '/fixtures/{id}/lineup/share', { invalidate });

  const announce = (text: string) => setMessage(text);
  const nameOf = (personId: string | undefined) =>
    personId ? shortName(byId.get(personId)?.displayName ?? 'Player') : '';

  const apply = useCallback(
    (from: Spot, to: Spot) => {
      setPlacement((current) => {
        const moving = from.kind === 'slot' ? current[from.slot] : from.personId;
        const next = placeOrSwap(current, from, to);
        if (moving) {
          announce(
            to.kind === 'bench'
              ? `${nameOf(moving)} to the bench.`
              : `${nameOf(moving)} placed as ${placeName(formation, to.slot)}${
                  current[to.slot] && current[to.slot] !== moving
                    ? `; ${nameOf(current[to.slot])} ${from.kind === 'slot' ? 'swapped' : 'to the bench'}`
                    : ''
                }.`,
          );
        }
        return next;
      });
      setPicked(null);
    },
    // nameOf reads byId; formation names the place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [formation, byId],
  );

  /** Tap, Enter or Space on a player or a place: pick, or drop the picked one there. */
  const choose = (spot: Spot) => {
    const personAt = spot.kind === 'slot' ? placement[spot.slot] : spot.personId;
    if (!picked) {
      if (!personAt) return;
      setPicked(spot);
      announce(`${nameOf(personAt)} chosen. Choose a place, or the bench.`);
      return;
    }
    if (spotKey(picked) === spotKey(spot)) {
      setPicked(null);
      announce('Let go.');
      return;
    }
    apply(picked, spot);
  };

  const onPointerDown = (spot: Spot, personId: string | undefined) => (e: React.PointerEvent) => {
    if (!personId || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({
      from: spot,
      personId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
    });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const moved =
      drag.moved ||
      Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD_PX;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
  };
  const onPointerUp = (spot: Spot) => (e: React.PointerEvent) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const from = drag.from;
    setDrag(null);
    if (!wasDrag) {
      choose(spot);
      return;
    }
    const target = spotFromElement(document.elementFromPoint(e.clientX, e.clientY));
    if (target) apply(from, target);
  };
  const dropTarget = drag?.moved
    ? spotFromElement(document.elementFromPoint(drag.x, drag.y))
    : null;

  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicked(null);
        announce('Let go.');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked]);

  const changeFormation = (next: string) => {
    setFormation(next);
    // Places beyond the new formation's go back to the bench.
    setPlacement((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([slot]) => Number(slot) <= placesOf(next)),
      ),
    );
  };

  const submitSave = async (): Promise<Schema<'Lineup'> | null> => {
    const previous = saved;
    try {
      const res = await save.submit({
        path: { id: sheet.fixtureId },
        body: {
          teamEntryId: sheet.teamEntryId,
          formation,
          slots: slotsOf(placement, formation),
          ...(previous ? { expectedRevision: previous.revision } : {}),
        },
      });
      return res;
    } catch {
      toast.show({ tone: 'error', message: 'The lineup was not saved. Try again.' });
      return null;
    }
  };

  const onSave = async () => {
    const before = saved;
    const result = await submitSave();
    if (!result) return;
    toast.show({
      tone: 'success',
      message: 'Lineup saved',
      ...(before
        ? {
            onUndo: () => {
              setFormation(before.formation);
              setPlacement(placementOf(before.slots));
              void save
                .submit({
                  path: { id: sheet.fixtureId },
                  body: {
                    teamEntryId: sheet.teamEntryId,
                    formation: before.formation,
                    slots: before.slots,
                    expectedRevision: result.revision,
                  },
                })
                .catch(() =>
                  toast.show({ tone: 'error', message: 'Undo did not save. Try again.' }),
                );
            },
          }
        : {}),
    });
  };

  const onShare = async () => {
    let revision = saved?.revision;
    if (dirty || !saved) {
      const result = await submitSave();
      if (!result) return;
      revision = result.revision;
    }
    if (revision === undefined) return;
    try {
      await share.submit({
        path: { id: sheet.fixtureId },
        body: { teamEntryId: sheet.teamEntryId, expectedRevision: revision },
      });
      toast.show({
        tone: 'success',
        message: 'Lineup shared. The families’ notice goes out once messaging is set up.',
      });
      void queryClient.invalidateQueries({ queryKey: ['api', '/me/fixtures'] });
    } catch {
      toast.show({ tone: 'error', message: 'The lineup was not shared. Try again.' });
    }
  };

  const average = sheet.teamAverageMinutes;
  const filled = slotsOf(placement, formation).length;
  const busy = save.isProcessing || share.isProcessing;
  const ghost = drag?.moved ? byId.get(drag.personId) : undefined;

  return (
    <div className="crew-body" onPointerMove={onPointerMove}>
      <div className="crew-card">
        <div className="crew-card-head">
          <h3>Formation</h3>
          <span className="crew-meta">
            {filled} of {places} placed · {going.length} going
          </span>
        </div>
        <SegmentedControl
          label="Formation"
          segments={FORMATIONS.filter((f) => placesOf(f) <= Math.max(7, going.length)).map((f) => ({
            value: f,
            label: f,
          }))}
          value={formation}
          onChange={changeFormation}
        />
      </div>

      <div
        className="lineup-pitch"
        role="group"
        aria-label={`Pitch, ${formation}`}
        data-testid="pitch"
      >
        <div className="lineup-lines" aria-hidden="true" />
        {rowsOf(formation).map((row, i, rows) => (
          <div
            key={row.line}
            className="lineup-row"
            // The goalkeeper at the bottom, the forwards at the top.
            style={{ top: `${88 - (i * 76) / Math.max(1, rows.length - 1)}%` }}
          >
            {row.slots.map((slot) => {
              const personId = placement[slot];
              const player = personId ? byId.get(personId) : undefined;
              const spot: Spot = { kind: 'slot', slot };
              const isPicked = picked?.kind === 'slot' && picked.slot === slot;
              const isTarget = dropTarget?.kind === 'slot' && dropTarget.slot === slot;
              return (
                <button
                  key={slot}
                  type="button"
                  className="lineup-slot"
                  data-drop={`slot:${slot}`}
                  data-picked={isPicked || undefined}
                  data-target={isTarget || undefined}
                  aria-pressed={isPicked}
                  aria-label={`${placeName(formation, slot)}: ${player ? player.displayName : 'empty'}`}
                  onPointerDown={onPointerDown(spot, personId)}
                  onPointerUp={onPointerUp(spot)}
                  onClick={(e) => {
                    // Keyboard Enter / Space (a pointer press is handled on pointer up).
                    if (e.detail === 0) choose(spot);
                  }}
                >
                  {slot === 1 ? (
                    <span className="lineup-keeper" aria-hidden="true">
                      GK
                    </span>
                  ) : null}
                  {player ? (
                    <Avatar
                      name={player.displayName}
                      personKey={player.personId}
                      size={46}
                      decorative
                    />
                  ) : (
                    <span className="lineup-empty" aria-hidden="true">
                      +
                    </span>
                  )}
                  <span className="lineup-slot-name" aria-hidden="true">
                    {player ? shortName(player.displayName) : placeName(formation, slot)}
                  </span>
                  {player && player.availability !== 'available' ? (
                    <StatusBadge tone="warning" label="Not going" size="sm" />
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <section
        className="crew-card"
        aria-labelledby="bench-title"
        data-drop="bench"
        data-testid="bench"
      >
        <div className="crew-card-head">
          <h3 id="bench-title">Bench</h3>
          <span className="crew-meta">
            Fewest minutes first · team average {Math.round(average)} min
          </span>
        </div>
        {bench.length === 0 ? (
          <p className="crew-empty">
            {going.length === 0
              ? 'Nobody has answered Going yet. Only players who answered Going appear here.'
              : 'Everyone who is going is on the pitch.'}
          </p>
        ) : (
          <div className="bench" role="list">
            {bench.map((p: TeamSheetPlayer) => {
              const spot: Spot = { kind: 'bench', personId: p.personId };
              const low = belowAverage(p, average);
              const isPicked = picked?.kind === 'bench' && picked.personId === p.personId;
              return (
                <div role="listitem" key={p.personId}>
                  <button
                    type="button"
                    className="bench-tile"
                    data-drop={`bench:${p.personId}`}
                    data-picked={isPicked || undefined}
                    aria-pressed={isPicked}
                    aria-label={`${p.displayName}, ${p.minutesThisSeason} minutes this season${low ? ', below the team average' : ''}`}
                    onPointerDown={onPointerDown(spot, p.personId)}
                    onPointerUp={onPointerUp(spot)}
                    onClick={(e) => {
                      if (e.detail === 0) choose(spot);
                    }}
                  >
                    <Avatar name={p.displayName} personKey={p.personId} size={44} decorative />
                    <span className="bench-name">{shortName(p.displayName)}</span>
                    <span className="bench-minutes" data-low={low || undefined}>
                      {low ? '▲ ' : ''}
                      {p.minutesThisSeason} min
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <p className="crew-meta">
          Drag a player onto a place, or choose a player and then a place. ▲ fewer minutes than the
          team average.
        </p>
      </section>

      <p className="visually-hidden" role="status" aria-live="polite" ref={live}>
        {message}
      </p>

      {saved?.sharedAt ? (
        <p
          className="crew-note"
          data-tone={saved.changedSinceShared || dirty ? 'warning' : 'success'}
        >
          {saved.changedSinceShared || dirty
            ? 'Changed since you shared it. Share again so families see the new lineup.'
            : `Shared ${clockOf(saved.sharedAt, sheet.timezone)}.`}
        </p>
      ) : null}
      <p className="crew-note">
        <ProposedTag label="Pending decision 8" /> Sharing is recorded now; the notice reaches
        families once a messaging service is chosen.
      </p>

      <div className="crew-actions">
        <Button
          variant="secondary"
          onClick={() => {
            setPlacement(autoFillFairly(sheet.players, placement, formation));
            announce('Filled fairly: the fewest minutes this season start.');
          }}
          disabled={going.length === 0}
        >
          Auto-fill fairly
        </Button>
        {canSave ? (
          <Button
            variant="secondary"
            onClick={() => void onSave()}
            busy={save.isProcessing && !share.isProcessing}
            disabled={!online || !dirty || busy}
            aria-describedby={online ? undefined : offlineId}
          >
            Save
          </Button>
        ) : null}
        {canSave ? (
          <Button
            className="button-lime"
            onClick={() => void onShare()}
            busy={share.isProcessing}
            disabled={!online || busy || filled === 0}
            aria-describedby={online ? undefined : offlineId}
          >
            Share
          </Button>
        ) : null}
      </div>
      {online ? null : (
        <p className="crew-meta" id={offlineId}>
          Saving and sharing need a connection; you can still arrange the lineup.
        </p>
      )}
      {!canSave ? (
        <p className="crew-meta">
          This game is no longer open for a lineup, or you do not coach this side.
        </p>
      ) : null}

      {ghost && drag ? (
        <div className="lineup-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          <Avatar name={ghost.displayName} personKey={ghost.personId} size={52} ring />
        </div>
      ) : null}
    </div>
  );
}

export function LineupScreen() {
  const { fixtureId = '' } = useParams();
  const [search] = useSearchParams();
  const team = search.get('team') ?? undefined;
  const sheet = useApiQuery({
    path: '/fixtures/{id}/lineup',
    request: { path: { id: fixtureId }, query: team ? { teamEntryId: team } : {} },
  });
  const data = sheet.data;
  return (
    <section aria-labelledby="lineup-title" className="crew ops-screen">
      <CrewHero
        titleId="lineup-title"
        back={{ to: '/workspace/week', label: 'My week' }}
        kicker={
          data?.scheduledStart
            ? `${dayLabelOf(data.scheduledStart, data.timezone)} · ${clockOf(data.scheduledStart, data.timezone)}${data.venueName ? ` · ${data.venueName}` : ''}`
            : 'Lineup'
        }
        title={data ? `${data.teamName} vs ${data.opponentName ?? 'bye'}` : 'Lineup'}
      />
      <QueryBoundary
        query={sheet}
        label="the lineup"
        loading={
          <SkeletonGroup label="the lineup" className="crew">
            <Skeleton height={80} radius={20} />
            <Skeleton height={420} radius={22} />
            <Skeleton height={160} radius={20} />
          </SkeletonGroup>
        }
        empty={{ title: '', description: '' }}
        unavailableOffline={['saving and sharing the lineup']}
      >
        {(d) => <Editor key={`${d.fixtureId}:${d.teamEntryId}`} sheet={d} />}
      </QueryBoundary>
    </section>
  );
}
