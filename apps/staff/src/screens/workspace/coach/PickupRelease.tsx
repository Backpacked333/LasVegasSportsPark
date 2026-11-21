/**
 * Staff S 3g "Coach · release a child at pickup" (phone 390, from "Pickup at 10:00" in S 2d;
 * INTERACTIONS 2d row 5; SPK-ENTRY-007, SPK-COND-004, DEC-005, DEC-034).
 *
 * - Pick a child who is here (✓ Here or ◷ Late in the session's attendance, not released from this
 *   phone yet); "7 of 9 left" counts them.
 * - "Who's picking Leo up?": big photo tiles of only the adults who may collect the child now
 *   (`GET /v1/releases/authorized-collectors`, names only; photo or initials). The coach matches
 *   the face; the family manages the list in their app.
 * - "Release Leo to Dana" names both people and records the release
 *   (`POST /v1/releases` with the session, one intent per child and adult): the API re-checks the
 *   authority at that moment and logs the time and the coach. Never optimistic: the button waits
 *   for the answer. A refused release says so and sends the coach to the desk.
 * - "Someone else" is a dead end on purpose: "Not authorised. Call the desk." The desk can verify
 *   ID and override; the coach's phone cannot.
 * - Offline: release needs a connection (no cached authority is ever used, DEC-034).
 */
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { useIntentSend } from '../../../api/useIntentSend';
import { activityFromAssignment, type ActivityRef } from '../../../features/operations/activity';
import { useApp } from '../../../providers/AppProviders';
import { Avatar } from '../../../ui/Avatar';
import { Icon } from '../../../ui/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { StateView } from '../../../ui/StateView';
import { useToast } from '../../../ui/Toast';
import type { WorkspaceAssignment } from '../MyAssignment';
import { MY_ASSIGNMENTS_KEY } from '../MyAssignment';
import { activityZone } from '../WorkspaceScreen';
import { clockText, sessionTitle, tileOf } from './tile-model';
import { useSessionRoster, type RosterChild } from './useSessionRoster';
import './coach.css';

type SessionRef = Extract<ActivityRef, { type: 'session' }>;

export function PickupReleaseScreen() {
  const { assignmentId = '' } = useParams();
  const assignments = useApiQuery({ path: '/me/assignments' });
  const item = assignments.data?.items.find((i) => i.assignment.id === assignmentId) ?? null;
  const activity = item ? activityFromAssignment(item.assignment) : null;
  if (assignments.error) {
    return (
      <StateView
        variant="error"
        error={assignments.error}
        onRetry={() => void assignments.refetch()}
      />
    );
  }
  if (!assignments.data) {
    return (
      <div className="coach-flow">
        <Skeleton height={120} radius={24} />
      </div>
    );
  }
  if (!item || !activity || activity.type !== 'session') {
    return (
      <StateView
        variant="unavailable"
        description="Pickup from the workspace is for your own program session."
      />
    );
  }
  return <Pickup item={item} activity={activity} />;
}

function Pickup({ item, activity }: { item: WorkspaceAssignment; activity: SessionRef }) {
  const { online } = useApp();
  const roster = useSessionRoster(activity);
  const [childId, setChildId] = useState<string | null>(null);
  const [released, setReleased] = useState<readonly string[]>([]);
  const title = roster.offeringName ?? sessionTitle(item.activity.title);
  const here = roster.children.filter((c) => {
    const s = tileOf(c.record?.effectiveState);
    return s === 'present' || s === 'late';
  });
  const left = here.filter((c) => !released.includes(c.personId));
  const child = childId ? (roster.children.find((c) => c.personId === childId) ?? null) : null;
  return (
    <section className="coach-flow" data-fullscreen aria-labelledby="pickup-title">
      <header className="coach-bar">
        {child ? (
          <button type="button" aria-label="Back to the children" onClick={() => setChildId(null)}>
            <Icon name="arrow_back" size={24} />
          </button>
        ) : (
          <Link to="/workspace" aria-label="Back to attendance">
            <Icon name="arrow_back" size={24} />
          </Link>
        )}
        <h2 id="pickup-title">Pickup · {title}</h2>
        {roster.attendance.data ? (
          <span className="coach-bar-step">
            {left.length} of {here.length} left
          </span>
        ) : null}
      </header>
      <div className="coach-flow-body">
        {!online ? (
          <div className="coach-callout" data-tone="warning" role="status">
            <Icon name="wifi_off" size={20} />
            <p>
              Release needs a connection: pickup authority is checked online at the moment of
              release, never from this phone&apos;s memory. Call the desk.
            </p>
          </div>
        ) : roster.attendance.error ? (
          <StateView
            variant="error"
            error={roster.attendance.error}
            onRetry={() => void roster.attendance.refetch()}
          />
        ) : !roster.attendance.data ? (
          <Skeleton height={160} radius={20} />
        ) : child ? (
          <ChooseAdult
            key={child.personId}
            item={item}
            activity={activity}
            child={child}
            onReleased={() => {
              setReleased((r) => [...r, child.personId]);
              setChildId(null);
            }}
          />
        ) : left.length === 0 ? (
          <StateView
            variant="empty"
            title={here.length === 0 ? 'Nobody is marked here yet' : 'Everyone is released'}
            description={
              here.length === 0
                ? 'Children marked ✓ Here or ◷ Late on the attendance tiles can be released here.'
                : 'Every child marked here has been released from this phone.'
            }
          />
        ) : (
          <>
            <h3>Who&apos;s going home?</h3>
            <ul className="coach-tiles" aria-label="Children to release">
              {left.map((c) => (
                <li key={c.personId} className="coach-tile-cell">
                  <button
                    type="button"
                    className="coach-tile"
                    data-state="unmarked"
                    onClick={() => setChildId(c.personId)}
                  >
                    <Avatar name={c.name} personKey={c.personId} size={44} decorative />
                    <b className="coach-tile-name">{c.name}</b>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

function ChooseAdult({
  item,
  activity,
  child,
  onReleased,
}: {
  item: WorkspaceAssignment;
  activity: SessionRef;
  child: RosterChild;
  onReleased: () => void;
}) {
  const toast = useToast();
  const zone = activityZone(item);
  const first = child.givenName ?? child.name.split(' ')[0] ?? child.name;
  const collectors = useApiQuery({
    path: '/releases/authorized-collectors',
    request: {
      query: {
        activityType: 'session',
        activityId: activity.sessionId,
        offeringId: activity.offeringId,
        participantPersonId: child.personId,
      },
    },
    staleTime: 0,
  });
  const [adultId, setAdultId] = useState<string | null>(null);
  const [someoneElse, setSomeoneElse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const { send } = useIntentSend([['api', '/attendance'], MY_ASSIGNMENTS_KEY]);
  const adults = useMemo(() => collectors.data?.collectors ?? [], [collectors.data]);
  const adult = adults.find((a) => a.personId === adultId) ?? null;

  const release = async () => {
    if (!adult) return;
    setBusy(true);
    setRefused(null);
    try {
      const result = await send(
        `release|${child.personId}|${adult.personId}`,
        'post',
        '/releases',
        {
          body: {
            facilityId: item.activity.facilityId,
            childPersonId: child.personId,
            collector: { personId: adult.personId },
            activity,
            recordDeparture: true,
          },
        },
      );
      const outcome = result.release.verificationOutcome;
      if (outcome === 'verified' && result.release.outcome === 'released') {
        toast.show({
          tone: 'success',
          message: `${first} released to ${adult.givenName} at ${clockText(result.release.authorityCheckedAt, zone)}`,
        });
        onReleased();
      } else {
        setRefused(
          `${first} was not released: ${adult.givenName} cannot collect ${first} right now. Call the desk.`,
        );
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      setRefused(
        `The release didn't save. Try again or call the desk.${code ? ` Code ${code}` : ''}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="coach-card">
        <Avatar name={child.name} personKey={child.personId} size={56} decorative />
        <span className="coach-card-text">
          <small>Releasing</small>
          <b>{child.name}</b>
        </span>
      </div>
      <h3 id="adults-title">Who&apos;s picking {first} up?</h3>
      {collectors.error ? (
        <StateView
          variant="error"
          error={collectors.error}
          onRetry={() => void collectors.refetch()}
        />
      ) : !collectors.data ? (
        <ul className="coach-adults" aria-label="Loading the adults">
          <li>
            <Skeleton height={160} radius={20} />
          </li>
          <li>
            <Skeleton height={160} radius={20} />
          </li>
        </ul>
      ) : (
        <ul className="coach-adults" aria-labelledby="adults-title">
          {adults.map((a) => {
            const picked = a.personId === adultId;
            return (
              <li key={a.personId}>
                <button
                  type="button"
                  className="coach-adult"
                  aria-pressed={picked}
                  onClick={() => {
                    setAdultId(a.personId);
                    setSomeoneElse(false);
                    setRefused(null);
                  }}
                >
                  <Avatar name={a.displayName} personKey={a.personId} size={80} decorative />
                  <b>{a.displayName}</b>
                  <span className="coach-adult-role">May collect</span>
                  {picked ? (
                    <i className="coach-adult-check" aria-hidden="true">
                      <Icon name="check" size={18} />
                    </i>
                  ) : null}
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="coach-adult"
              data-kind="other"
              aria-pressed={someoneElse}
              onClick={() => {
                setSomeoneElse(true);
                setAdultId(null);
              }}
            >
              <Icon name="person_off" size={32} />
              <b>Someone else</b>
              <span className="coach-adult-role">Not allowed from this phone. Call the desk.</span>
            </button>
          </li>
        </ul>
      )}
      {someoneElse ? (
        <div className="coach-callout" data-tone="warning" role="alert">
          <Icon name="block" size={20} />
          <p>
            <b>Not authorised. Call the desk.</b> Keep {first} with you. The desk can check ID and
            decide; there is no override from this phone.
          </p>
        </div>
      ) : null}
      {refused ? (
        <div className="coach-callout" data-tone="warning" role="alert">
          <Icon name="error" size={20} />
          <p>{refused}</p>
        </div>
      ) : null}
      <p className="coach-note">
        Match the face to the person in front of you. The family manages this list in their app.
      </p>
      <div className="coach-actions">
        <button
          type="button"
          className="coach-primary"
          disabled={!adult || busy}
          aria-busy={busy || undefined}
          onClick={() => void release()}
        >
          <Icon name="family_restroom" size={22} />
          {busy
            ? 'Checking…'
            : adult
              ? `Release ${first} to ${adult.givenName}`
              : `Choose who is collecting ${first}`}
        </button>
      </div>
    </>
  );
}
