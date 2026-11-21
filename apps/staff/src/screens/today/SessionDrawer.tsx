/**
 * S 3a Session drawer (INTERACTIONS 1a row 1; S 1d row 2 opens the same on a phone): a next-hour
 * card (or a field board block) opens it from the right over the dimmed page; Escape or ✕ closes
 * it and focus returns to the card.
 *
 * - The dark header: "Starts in 14 min", the activity, its time, space and kind.
 * - The checks as tiles (Referee, Forms, Field…), then the blocking ones with their fix inline: the
 *   referee candidates with Assign / Ask, the children without a waiver, the closed field.
 * - Players: for a game, each side's roster (`GET /v1/team-entries/{id}/roster`) with each
 *   player's answer (`GET /v1/fixtures/{id}` responses: ✓ Going, ✕ Not going, ▲ No answer); for a
 *   class, the expected children (`GET /v1/attendance`) with a waiver flag. Four at first, "Show
 *   all" for the rest. Care notes are not read here: they are protected and every read is
 *   audited, so they are read where they are needed, at check-in (S 2a).
 * - Notes: the fixture's notes.
 * - Footer: Move (the schedule), Cancel game (S 3b), Open check-in (the arrival desk filtered to
 *   this activity: `/arrival?type=…`, the query `activityFromSearch` reads).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Drawer } from '../../ui/Drawer';
import { Icon } from '../../ui/Icon';
import { SkeletonGroup, SkeletonLines } from '../../ui/Skeleton';
import { STATUS_GLYPHS } from '../../ui/StatusBadge';
import { RefereeFix, type RefereeTarget } from './RefereeFix';
import { isFailed, kindLine, useStartChecks, type FixKind, type StartCheck } from './start-checks';
import { shortTime, startsIn, type ResourceStatus, type ScheduledEvent } from './today-model';

const PLAYERS_SHOWN = 4;

type Answer = Schema<'AvailabilityState'>;
const ANSWER: Record<Answer, { glyph: string; word: string; tone: string }> = {
  available: { glyph: STATUS_GLYPHS.success, word: 'Going', tone: 'success' },
  unavailable: { glyph: STATUS_GLYPHS.danger, word: 'Not going', tone: 'danger' },
  tentative: { glyph: STATUS_GLYPHS.pending, word: 'Maybe', tone: 'pending' },
  no_response: { glyph: STATUS_GLYPHS.warning, word: 'No answer', tone: 'warning' },
};

export interface DrawerContext {
  timeZone: string;
  resources: readonly ResourceStatus[] | undefined;
  sessions: readonly Schema<'FacilitySession'>[] | undefined;
  spaceNames: ReadonlyMap<string, string>;
  uncovered: ReadonlyMap<string, ReadonlySet<string>>;
  /** The Today item of an uncovered referee for this event, for the replacements read. */
  staffingTargetOf: (event: ScheduledEvent) => RefereeTarget | null;
  now: Date;
}

function CheckTile({ check }: { check: StartCheck }) {
  return (
    <div className="drawer-check" data-tone={check.tone}>
      <span className="drawer-check-head">{check.heading}</span>
      <b>
        <span aria-hidden="true">{STATUS_GLYPHS[check.tone]}</span> {check.value}
      </b>
    </div>
  );
}

function GamePlayers({ fixtureId }: { fixtureId: string }) {
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const home = fixture.data?.home;
  const roster = useApiQuery({
    path: '/team-entries/{id}/roster',
    request: { path: { id: home?.entryId ?? '' } },
    enabled: !!home,
  });
  const [all, setAll] = useState(false);
  if (fixture.isPending || (home && roster.isPending)) {
    return (
      <SkeletonGroup label="players">
        <SkeletonLines lines={3} />
      </SkeletonGroup>
    );
  }
  if (!home || !roster.data) {
    return <p className="caption">Players are not available to you.</p>;
  }
  const answers = new Map(fixture.data!.responses.map((r) => [r.personId, r.state]));
  const players = roster.data.members.filter((m) =>
    ['active', 'guest', 'substitute'].includes(m.status),
  );
  const going = players.filter((p) => answers.get(p.personId) === 'available').length;
  const shown = all ? players : players.slice(0, PLAYERS_SHOWN);
  return (
    <section className="drawer-section" aria-labelledby="drawer-players">
      <div className="drawer-section-head">
        <h4 id="drawer-players">
          {home.teamName} · {going} of {players.length} answered going
        </h4>
        <Link to="/communications/compose">Message team</Link>
      </div>
      <ul className="player-grid">
        {shown.map((p) => {
          const answer = ANSWER[answers.get(p.personId) ?? 'no_response'];
          return (
            <li key={p.personId} className="player-tile">
              <Avatar name={p.displayName} personKey={p.personId} size={34} decorative />
              <span className="player-text">
                <b>{p.displayName}</b>
                <span className="player-answer" data-tone={answer.tone}>
                  <span aria-hidden="true">{answer.glyph}</span> {answer.word}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {players.length > PLAYERS_SHOWN ? (
        <button type="button" className="link-button" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${players.length} players`}
        </button>
      ) : null}
    </section>
  );
}

function SessionPlayers({
  sessionId,
  offeringId,
  missing,
}: {
  sessionId: string;
  offeringId: string;
  missing: ReadonlySet<string>;
}) {
  const attendance = useApiQuery({
    path: '/attendance',
    request: { query: { activityType: 'session', activityId: sessionId, offeringId } },
  });
  const [all, setAll] = useState(false);
  if (attendance.isPending) {
    return (
      <SkeletonGroup label="children">
        <SkeletonLines lines={3} />
      </SkeletonGroup>
    );
  }
  const expected = attendance.data?.expected ?? null;
  if (!expected) return <p className="caption">The class list is not available to you.</p>;
  const shown = all ? expected : expected.slice(0, PLAYERS_SHOWN);
  return (
    <section className="drawer-section" aria-labelledby="drawer-players">
      <div className="drawer-section-head">
        <h4 id="drawer-players">{expected.length} expected</h4>
      </div>
      <ul className="player-grid">
        {shown.map((p) => {
          const name = p.displayName ?? [p.givenName, p.familyName].filter(Boolean).join(' ');
          const flagged = missing.has(p.personId);
          return (
            <li key={p.personId} className="player-tile">
              <Avatar name={name} personKey={p.personId} size={34} decorative />
              <span className="player-text">
                <b>{name}</b>
                <span className="player-answer" data-tone={flagged ? 'warning' : 'success'}>
                  <span aria-hidden="true">
                    {flagged ? STATUS_GLYPHS.warning : STATUS_GLYPHS.success}
                  </span>{' '}
                  {flagged ? 'Waiver missing' : 'Cleared'}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {expected.length > PLAYERS_SHOWN ? (
        <button type="button" className="link-button" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${expected.length}`}
        </button>
      ) : null}
    </section>
  );
}

function FixtureNotes({ fixtureId }: { fixtureId: string }) {
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const notes = fixture.data?.notes;
  if (!notes) return null;
  return (
    <section className="drawer-section" aria-labelledby="drawer-notes">
      <h4 id="drawer-notes">Notes</h4>
      <p className="drawer-note">{notes}</p>
    </section>
  );
}

export function checkInPath(
  event: ScheduledEvent,
  sessionId: string | null,
  offeringId: string | null,
): string {
  return sessionId && offeringId
    ? `/arrival?type=session&offeringId=${offeringId}&sessionId=${sessionId}`
    : `/arrival?type=event&eventId=${event.id}`;
}

export function SessionDrawer({
  event,
  focus,
  context,
  onClose,
  onCancel,
}: {
  event: ScheduledEvent;
  focus: FixKind | null;
  context: DrawerContext;
  onClose: () => void;
  onCancel: (event: ScheduledEvent) => void;
}) {
  const result = useStartChecks(event, {
    resources: context.resources,
    sessions: context.sessions,
    uncoveredRoles: context.uncovered.get(event.id) ?? new Set(),
  });
  const space = event.resourceIds
    .map((id) => context.spaceNames.get(id))
    .filter(Boolean)
    .join(', ');
  const failedChecks = result.checks.filter(isFailed);
  const staffing = context.staffingTargetOf(event);
  const referee = result.checks.find(
    (c) => (c.key === 'referee' || c.key === 'coach') && isFailed(c),
  );
  const target: RefereeTarget | null =
    staffing ??
    (referee && result.fixtureId && result.requirementId
      ? {
          targetType: 'fixture',
          targetId: result.fixtureId,
          kind: 'official',
          role: 'referee',
          requirementId: result.requirementId,
          title: event.title,
        }
      : null);
  const waivers = result.checks.find((c) => c.key === 'waivers' && isFailed(c));
  const field = result.checks.find((c) => c.key === 'field' && isFailed(c));
  const missing = new Set(result.missingWaivers.map((m) => m.personId));
  const canCancel = event.status === 'published' && new Date(event.scheduledEnd) > context.now;

  return (
    <Drawer
      open
      onClose={onClose}
      labelledBy="session-drawer-title"
      tone="night"
      testId="session-drawer"
      header={
        <div className="drawer-hero">
          <span className="drawer-pill">
            <span className="live-dot" aria-hidden="true" />
            {startsIn(event.scheduledStart, context.now)}
          </span>
          <h3 id="session-drawer-title">{event.title}</h3>
          <span className="drawer-sub">
            {shortTime(event.scheduledStart, context.timeZone, true)}–
            {shortTime(event.scheduledEnd, context.timeZone, true)}
            {space ? ` · ${space}` : ''} · {kindLine(event)}
          </span>
        </div>
      }
      footer={
        <>
          <Link className="button button-secondary" to="/schedule">
            <Icon name="edit_calendar" size={18} />
            Move
          </Link>
          {canCancel ? (
            <Button
              variant="secondary"
              className="button-danger-outline"
              onClick={() => onCancel(event)}
            >
              <Icon name="cancel" size={18} />
              {event.kind === 'game' ? 'Cancel game' : 'Cancel'}
            </Button>
          ) : null}
          <span className="spacer" />
          <Link
            className="button button-primary"
            to={checkInPath(event, result.sessionId, result.offeringId)}
          >
            <Icon name="qr_code_scanner" size={18} />
            Open check-in
          </Link>
        </>
      }
    >
      {result.loading ? (
        <SkeletonGroup label="checks">
          <SkeletonLines lines={2} />
        </SkeletonGroup>
      ) : result.checks.length > 0 ? (
        <div className="drawer-checks" data-count={Math.min(result.checks.length, 3)}>
          {[...failedChecks, ...result.checks.filter((c) => !isFailed(c))].slice(0, 3).map((c) => (
            <CheckTile key={c.key} check={c} />
          ))}
        </div>
      ) : null}
      {referee && target ? (
        <div
          className="drawer-fix"
          data-tone="danger"
          data-focus={focus === 'referee' || undefined}
        >
          <b>
            <span aria-hidden="true">✕</span> No {target.role.replaceAll('_', ' ')} assigned. Best
            matches:
          </b>
          <RefereeFix target={target} timeZone={context.timeZone} />
        </div>
      ) : null}
      {waivers ? (
        <div
          className="drawer-fix"
          data-tone="warning"
          data-focus={focus === 'waivers' || undefined}
        >
          <b>
            <span aria-hidden="true">▲</span> {waivers.label}
          </b>
          {result.missingWaivers.length > 0 ? (
            <span>
              {result.missingWaivers.map((m) => m.name).join(', ')}. Parents can sign at the desk
              tablet on arrival.
            </span>
          ) : null}
        </div>
      ) : null}
      {field ? (
        <div className="drawer-fix" data-tone="danger" data-focus={focus === 'field' || undefined}>
          <b>
            <span aria-hidden="true">✕</span> {field.value}
          </b>
          <Link to="/facilities/restrictions">Open restrictions</Link>
        </div>
      ) : null}
      {result.fixtureId ? <GamePlayers fixtureId={result.fixtureId} /> : null}
      {result.sessionId && result.offeringId ? (
        <SessionPlayers
          sessionId={result.sessionId}
          offeringId={result.offeringId}
          missing={missing}
        />
      ) : null}
      {result.fixtureId ? <FixtureNotes fixtureId={result.fixtureId} /> : null}
    </Drawer>
  );
}
