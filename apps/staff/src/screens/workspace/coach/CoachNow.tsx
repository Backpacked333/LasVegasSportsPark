/**
 * Staff S 2d "Coach workspace · take attendance by tapping" (phone 390; INTERACTIONS "2d · Coach:
 * attendance"; SPK-ENTRY-005, SPK-ENTRY-004, SPK-UX-007, §4.15).
 *
 * The coach's session now (`currentSession`): a night header with the phase ("Now · 12 min in"),
 * the class, its time and place, and the four counts; then big tiles, one per child, with the
 * photo or initials, the name and the state written and coloured (✓ Here, ◷ Late with its time,
 * ✕ Absent, Unmarked). A tap cycles Unmarked → Here → Late → Unmarked; a long press (0.5 s, a
 * light vibration where the phone has one) marks Absent; keyboard: Enter or Space cycles, A marks
 * absent. Writes are optimistic with Undo and queue offline (`useTileAttendance`).
 *
 * Flags on the tile: ▲ form (a required waiver missing or lapsed) and ✕ allergy / ● care (an
 * operational care note); tapping a flag opens a bottom sheet with the detail. Care-note text is
 * read only on that tap, and every read is recorded in the audit log by the API.
 *
 * "Show all 14" expands the grid past the first six; "Pickup at 10:00" opens the release (S 3g).
 * The workspace tab bar stays below.
 */
import { presentationForError } from '@sportspark/api-client';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { activityFromAssignment, type ActivityRef } from '../../../features/operations/activity';
import { useNow } from '../../../providers/AppProviders';
import { Avatar } from '../../../ui/Avatar';
import { BottomSheet } from '../../../ui/BottomSheet';
import { Icon } from '../../../ui/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { StateView } from '../../../ui/StateView';
import type { WorkspaceAssignment } from '../MyAssignment';
import { activityZone } from '../WorkspaceScreen';
import {
  TILE_LABEL,
  clockText,
  countTiles,
  phaseText,
  sessionTitle,
  tileName,
  type TileState,
} from './tile-model';
import { useSessionRoster, type RosterChild } from './useSessionRoster';
import { useTileAttendance, type TileView } from './useTileAttendance';
import './coach.css';

/** Tiles shown before "Show all". */
export const FIRST_TILES = 6;
/** A press this long marks the child absent. */
export const HOLD_MS = 500;

type Flag = { personId: string; kind: 'form' | 'care' };

export function CoachNow({ item }: { item: WorkspaceAssignment }) {
  const activity = activityFromAssignment(item.assignment);
  if (!activity || activity.type !== 'session') {
    return (
      <StateView
        variant="unavailable"
        description="Attendance by tapping is for your own program session."
      />
    );
  }
  return <CoachNowSession item={item} activity={activity} />;
}

function CoachNowSession({
  item,
  activity,
}: {
  item: WorkspaceAssignment;
  activity: Extract<ActivityRef, { type: 'session' }>;
}) {
  const now = useNow(30_000);
  const zone = activityZone(item);
  const roster = useSessionRoster(activity);
  const title = roster.offeringName ?? sessionTitle(item.activity.title);
  const tiles = useTileAttendance({
    activity,
    facilityId: item.activity.facilityId,
    title,
    children: roster.children,
    attendanceUpdatedAt: roster.attendance.updatedAt,
    attendanceServerDate: roster.attendance.serverDate,
  });
  const [expanded, setExpanded] = useState(false);
  const [flag, setFlag] = useState<Flag | null>(null);
  const views = roster.children.map((c) => ({ child: c, view: tiles.view(c.personId) }));
  const counts = countTiles(views.map((v) => v.view.state));
  const phase = phaseText(item.activity.scheduledStart, item.activity.scheduledEnd, now);
  const loading = roster.attendance.isLoading;
  const shown = expanded ? views : views.slice(0, FIRST_TILES);
  const flagChild = flag ? roster.children.find((c) => c.personId === flag.personId) : undefined;
  return (
    <section className="coach-now" aria-labelledby="coach-now-title">
      <header className="coach-hero">
        <span className="coach-phase" data-live={phase.live || undefined}>
          <i aria-hidden="true" />
          {phase.text}
        </span>
        <h2 id="coach-now-title" className="coach-title">
          {title}
        </h2>
        <span className="coach-meta">
          {clockText(item.activity.scheduledStart, zone)}–
          {clockText(item.activity.scheduledEnd, zone)}
          {roster.location ? ` · ${roster.location}` : ''}
          {loading ? '' : ` · ${roster.children.length} registered`}
        </span>
        <ul className="coach-counts" aria-label="Attendance so far">
          <li>
            <b>{counts.present}</b>
            <span>Here</span>
          </li>
          <li data-tone="late">
            <b>{counts.late}</b>
            <span>Late</span>
          </li>
          <li data-tone="absent">
            <b>{counts.absent}</b>
            <span>Absent</span>
          </li>
          <li>
            <b>{counts.unmarked}</b>
            <span>Unmarked</span>
          </li>
        </ul>
      </header>
      <div className="coach-body">
        <p className="coach-hint" id="coach-hint">
          Tap once for here, twice for late, hold for absent
        </p>
        {roster.attendance.error ? (
          <StateView
            variant="error"
            error={roster.attendance.error}
            onRetry={() => void roster.attendance.refetch()}
          />
        ) : loading ? (
          <ul className="coach-tiles" aria-label="Loading the children">
            {Array.from({ length: FIRST_TILES }, (_, i) => (
              <li key={i}>
                <Skeleton height={92} radius={16} />
              </li>
            ))}
          </ul>
        ) : roster.children.length === 0 ? (
          <StateView
            variant="empty"
            title="No children yet"
            description="Children registered for this session appear here."
          />
        ) : (
          <ul className="coach-tiles" aria-label="Children">
            {shown.map(({ child, view }) => (
              <ChildTile
                key={child.personId}
                child={child}
                view={view}
                zone={zone}
                onTap={() => tiles.tap(child.personId)}
                onHold={() => tiles.hold(child.personId)}
                onFlag={(kind) => setFlag({ personId: child.personId, kind })}
              />
            ))}
          </ul>
        )}
        {views.length > FIRST_TILES ? (
          <button
            type="button"
            className="coach-showall"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? 'Show fewer' : `Show all ${views.length}`}
          </button>
        ) : null}
        <Link className="coach-pickup" to={`/workspace/assignments/${item.assignment.id}/pickup`}>
          <span className="coach-pickup-icon" aria-hidden="true">
            <Icon name="family_restroom" size={22} />
          </span>
          <span className="coach-pickup-text">
            <b>Pickup at {clockText(item.activity.scheduledEnd, zone)}</b>
            <span>Release each child to an authorized adult</span>
          </span>
          <Icon name="chevron_right" size={22} />
        </Link>
        <p className="coach-links">
          <Link to={`/workspace/assignments/${item.assignment.id}/attendance`}>
            Corrections and history
          </Link>
          <Link to="/workspace?view=list">All my assignments</Link>
        </p>
      </div>
      <BottomSheet
        open={flag !== null && flagChild !== undefined}
        onClose={() => setFlag(null)}
        title={flagChild ? flagChild.name : ''}
        titleId="coach-flag-title"
        testId="coach-flag-sheet"
      >
        {flag && flagChild ? (
          flag.kind === 'form' ? (
            <FormDetail child={flagChild} />
          ) : (
            <CareDetail child={flagChild} activity={activity} />
          )
        ) : null}
      </BottomSheet>
    </section>
  );
}

function ChildTile({
  child,
  view,
  zone,
  onTap,
  onHold,
  onFlag,
}: {
  child: RosterChild;
  view: TileView;
  zone: string | null;
  onTap: () => void;
  onHold: () => void;
  onFlag: (kind: 'form' | 'care') => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const label = TILE_LABEL[view.state];
  const short = tileName(child.name);
  const stateText =
    view.state === 'late' && view.at
      ? `${label.glyph} Late ${clockText(view.at, zone)}`
      : `${label.glyph ? `${label.glyph} ` : ''}${label.word}`;
  const next: Record<TileState, string> = {
    unmarked: 'Tap to mark here',
    present: 'Tap to mark late',
    late: 'Tap to change',
    absent: 'Tap to mark here',
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    held.current = false;
    clear();
    timer.current = setTimeout(() => {
      held.current = true;
      timer.current = null;
      onHold();
    }, HOLD_MS);
  };
  const onClick = () => {
    if (held.current) {
      held.current = false;
      return;
    }
    onTap();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      onHold();
    }
  };
  const allergy = child.careKinds.includes('allergy');
  return (
    <li className="coach-tile-cell">
      <button
        type="button"
        className="coach-tile"
        data-state={view.state}
        data-waiting={view.waiting || undefined}
        data-conflict={view.conflict || undefined}
        disabled={view.conflict}
        aria-label={`${child.name}, ${stateText.replace(/^[✓◷✕] /, '')}${view.queued ? ', queued on this device' : ''}. ${view.conflict ? 'Conflicting marks: review in corrections and history.' : `${next[view.state]}; hold or press A for absent.`}`}
        onPointerDown={onPointerDown}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onContextMenu={(e) => e.preventDefault()}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <Avatar name={child.name} personKey={child.personId} size={36} decorative />
        <b className="coach-tile-name">{short}</b>
        <span className="coach-tile-state">
          {view.conflict ? '✕ Review' : stateText}
          {view.queued ? ' · queued' : ''}
        </span>
      </button>
      {child.missingForms.length > 0 || child.careKinds.length > 0 ? (
        <span className="coach-flags">
          {child.missingForms.length > 0 ? (
            <button
              type="button"
              className="coach-flag"
              data-tone="warning"
              aria-label={`Form missing for ${child.name}: details`}
              onClick={() => onFlag('form')}
            >
              ▲ form
            </button>
          ) : null}
          {child.careKinds.length > 0 ? (
            <button
              type="button"
              className="coach-flag"
              data-tone={allergy ? 'danger' : 'info'}
              aria-label={`${allergy ? 'Allergy' : 'Care note'} for ${child.name}: details`}
              onClick={() => onFlag('care')}
            >
              {allergy ? '✕ allergy' : 'ℹ care'}
            </button>
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

function FormDetail({ child }: { child: RosterChild }) {
  return (
    <div className="coach-sheet-body">
      <p>
        <b>{child.missingForms.join(', ')}</b> is not signed for {child.name.split(' ')[0]}.
      </p>
      <p className="caption">
        The front desk can have a parent sign it on the desk tablet. Mark attendance as usual; the
        desk follows up.
      </p>
    </div>
  );
}

function CareDetail({
  child,
  activity,
}: {
  child: RosterChild;
  activity: Extract<ActivityRef, { type: 'session' }>;
}) {
  const notes = useApiQuery({
    path: '/attendance/care-notes',
    request: {
      query: {
        activityType: 'session',
        activityId: activity.sessionId,
        offeringId: activity.offeringId,
        personId: child.personId,
      },
    },
    staleTime: 0,
  });
  if (notes.error) {
    return (
      <div className="coach-sheet-body">
        <p>
          {presentationForError(notes.error) === 'unavailable'
            ? 'Care notes are not shown to your role.'
            : 'The care note could not load. Try again, or ask the front desk.'}
        </p>
        <p className="caption">Code {notes.error.code}</p>
      </div>
    );
  }
  if (!notes.data) {
    return (
      <div className="coach-sheet-body">
        <Skeleton height={48} />
      </div>
    );
  }
  return (
    <div className="coach-sheet-body">
      <ul className="coach-care" aria-label={`Care notes for ${child.name}`}>
        {notes.data.notes.map((n) => (
          <li key={n.id} data-kind={n.kind}>
            <b>{n.kind === 'allergy' ? '✕ Allergy' : 'ℹ Care'}</b>
            <span>{n.body}</span>
          </li>
        ))}
      </ul>
      <p className="caption">
        <Icon name="lock" size={14} /> Protected: this view is recorded in the audit log.
      </p>
    </div>
  );
}
