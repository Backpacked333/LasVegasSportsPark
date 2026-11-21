/**
 * Staff S 4d "Coach · report an injury" (phone 390, the Issues tab of the coach workspace;
 * SPK-DISC-001 operational incidents, SPK-DISC-005 operational facts, never a diagnosis,
 * SPK-UX-006, SPK-COMMS-002).
 *
 * Three taps-first steps a coach can finish on the sideline: who (a child of the session now) →
 * what (where the injury is, what was done) → review; a head injury adds a concussion checklist
 * step. Sending records one restricted `injury` incident on the session (`POST /v1/incidents` with
 * the offering and session, one intent per report): the API raises an issue on the manager's
 * Today, tells the child's guardians through their notification settings, and keeps it with the
 * child's record. Sending waits for the answer (a safety record is never shown as sent before it
 * is), and needs a connection: offline the coach is told to call the desk.
 *
 * The summary carries only where and what was done (it is the Today title, read by staff); the
 * concussion signs and the coach's note go in the restricted narrative (SPK-DISC-004).
 *
 * Proposed (shown in the pending tone): a voice note instead of typing. Browsers can record, but
 * the API stores no attachments, so the button is disabled and a typed note stands in.
 * A field or equipment problem is still reported from here (`/workspace/report-problem`).
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiQuery } from '../../../api/useApiQuery';
import { useIntentSend } from '../../../api/useIntentSend';
import { activityFromAssignment, type ActivityRef } from '../../../features/operations/activity';
import { useApp, useNow } from '../../../providers/AppProviders';
import { Avatar } from '../../../ui/Avatar';
import { Icon } from '../../../ui/Icon';
import { Skeleton } from '../../../ui/Skeleton';
import { StateView } from '../../../ui/StateView';
import type { WorkspaceAssignment } from '../MyAssignment';
import { activityZone } from '../WorkspaceScreen';
import { clockText, currentSession, sessionTitle, tileOf } from './tile-model';
import { useSessionRoster, type RosterChild } from './useSessionRoster';
import './coach.css';

type SessionRef = Extract<ActivityRef, { type: 'session' }>;

export const BODY_PARTS = ['Head', 'Arm / hand', 'Ankle / foot', 'Knee / leg', 'Other'] as const;
export type BodyPart = (typeof BODY_PARTS)[number];

export const ACTIONS = ['Ice and rest', 'Sat out the rest of the session', 'Called 911'] as const;

/** Signs that make a head knock serious (operational observations, not a diagnosis). */
export const CONCUSSION_SIGNS = [
  'Lost consciousness, even briefly',
  'Headache or pressure in the head',
  'Dizzy or off balance',
  'Confused, or does not remember the knock',
  'Felt sick or vomited',
  'Blurry vision or sensitive to light',
] as const;

/** The voice note waits on attachment storage in the API (none today): shown as proposed. */
export const VOICE_NOTES_AVAILABLE = false;

type Severity = 'low' | 'medium' | 'high';

/** Severity from the facts given: 911 or any concussion sign is high, a head knock medium. */
export function severityOf(
  part: BodyPart,
  actions: readonly string[],
  signs: readonly string[],
): Severity {
  if (actions.includes('Called 911') || signs.length > 0) return 'high';
  if (part === 'Head') return 'medium';
  return 'low';
}

/** The safe summary (no names): "Ankle / foot: ice and rest; sat out the rest of the session". */
export function summaryOf(part: BodyPart, actions: readonly string[]): string {
  const did = actions.map((a) => a.charAt(0).toLowerCase() + a.slice(1)).join('; ');
  return `${part}${did ? `: ${did}` : ''}`.slice(0, 300);
}

export function InjuryReportScreen() {
  const assignments = useApiQuery({ path: '/me/assignments' });
  const now = useNow(60_000);
  const item = useMemo(() => {
    const items = assignments.data?.items ?? [];
    return (
      currentSession(items, now) ??
      // Otherwise today's last coached session that has started.
      [...items]
        .filter(
          (i) =>
            i.assignment.kind === 'coach' &&
            i.assignment.targetType === 'session' &&
            (i.assignment.status === 'accepted' || i.assignment.status === 'completed') &&
            new Date(i.activity.scheduledStart).getTime() <= now.getTime() &&
            now.getTime() - new Date(i.activity.scheduledEnd).getTime() < 12 * 3_600_000,
        )
        .sort((a, b) => b.activity.scheduledStart.localeCompare(a.activity.scheduledStart))[0] ??
      null
    );
  }, [assignments.data, now]);
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
      <section className="coach-flow" aria-labelledby="injury-title">
        <header className="coach-bar">
          <Link to="/workspace" aria-label="Close">
            <Icon name="close" size={24} />
          </Link>
          <h2 id="injury-title">Report an issue</h2>
        </header>
        <div className="coach-flow-body">
          <StateView
            variant="empty"
            title="No session on now"
            description="An injury is reported from the session you are coaching. A field or equipment problem can be reported any time."
          />
          <Link className="coach-secondary" to="/workspace/report-problem">
            <Icon name="construction" size={20} />
            Report a field or equipment problem
          </Link>
        </div>
      </section>
    );
  }
  return <InjuryFlow item={item} activity={activity} />;
}

type Step = 'who' | 'what' | 'head' | 'review' | 'sent';

function InjuryFlow({ item, activity }: { item: WorkspaceAssignment; activity: SessionRef }) {
  const { online, services } = useApp();
  const navigate = useNavigate();
  const zone = activityZone(item);
  const roster = useSessionRoster(activity);
  const title = roster.offeringName ?? sessionTitle(item.activity.title);
  const [step, setStep] = useState<Step>('who');
  const [childId, setChildId] = useState<string | null>(null);
  const [part, setPart] = useState<BodyPart | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [signs, setSigns] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [at] = useState(() => services.now().toISOString());
  const { send } = useIntentSend([['api', '/today']]);
  const child = roster.children.find((c) => c.personId === childId) ?? null;
  const head = part === 'Head';
  const total = head ? 4 : 3;
  const number: Record<Step, number> = { who: 1, what: 2, head: 3, review: total, sent: total };
  const first = child ? (child.givenName ?? child.name.split(' ')[0] ?? child.name) : '';
  const ordered = [...roster.children].sort((a, b) => {
    const hereA = ['present', 'late'].includes(tileOf(a.record?.effectiveState)) ? 0 : 1;
    const hereB = ['present', 'late'].includes(tileOf(b.record?.effectiveState)) ? 0 : 1;
    return hereA - hereB || a.name.localeCompare(b.name);
  });
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const submit = async () => {
    if (!child || !part) return;
    setBusy(true);
    setError(null);
    const narrative = [
      signs.length > 0
        ? `Concussion signs seen: ${signs.join('; ')}.`
        : head
          ? 'No concussion signs seen.'
          : '',
      note.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await send(`injury|${child.personId}|${at}`, 'post', '/incidents', {
        body: {
          kind: 'injury',
          offeringId: activity.offeringId,
          sessionId: activity.sessionId,
          subjectPersonId: child.personId,
          occurredAt: at,
          severity: severityOf(part, actions, signs),
          summary: summaryOf(part, actions),
          ...(narrative ? { narrative } : {}),
          evidence: [],
        },
      });
      setStep('sent');
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      setError(
        `The report didn't send. Try again, or call the desk if it's urgent.${code ? ` Code ${code}` : ''}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    if (step === 'what') setStep('who');
    else if (step === 'head') setStep('what');
    else if (step === 'review') setStep(head ? 'head' : 'what');
  };

  return (
    <section className="coach-flow" aria-labelledby="injury-title">
      <header className="coach-bar">
        <Link to="/workspace" aria-label="Close the report">
          <Icon name="close" size={24} />
        </Link>
        <h2 id="injury-title">{step === 'sent' ? 'Report sent' : 'Report an injury'}</h2>
        {step !== 'sent' ? (
          <span className="coach-bar-step">
            Step {number[step]} of {total}
          </span>
        ) : null}
      </header>
      <div className="coach-flow-body">
        {child && step !== 'who' ? (
          <ChildCard
            child={child}
            title={title}
            location={roster.location}
            time={clockText(at, zone)}
          />
        ) : null}

        {step === 'who' ? (
          <>
            <h3 id="who-title">Who&apos;s hurt?</h3>
            {roster.attendance.error ? (
              <StateView
                variant="error"
                error={roster.attendance.error}
                onRetry={() => void roster.attendance.refetch()}
              />
            ) : !roster.attendance.data ? (
              <Skeleton height={180} radius={16} />
            ) : (
              <ul className="coach-tiles" aria-labelledby="who-title">
                {ordered.map((c) => (
                  <li key={c.personId} className="coach-tile-cell">
                    <button
                      type="button"
                      className="coach-tile"
                      data-state="unmarked"
                      onClick={() => {
                        setChildId(c.personId);
                        setStep('what');
                      }}
                    >
                      <Avatar name={c.name} personKey={c.personId} size={40} decorative />
                      <b className="coach-tile-name">{c.name}</b>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Link className="coach-note" to="/workspace/report-problem">
              A field or equipment problem instead? Report it here.
            </Link>
          </>
        ) : null}

        {step === 'what' && child ? (
          <>
            <h3 id="where-title">Where&apos;s the injury?</h3>
            <div className="coach-chips" role="radiogroup" aria-labelledby="where-title">
              {BODY_PARTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  className="coach-chip"
                  aria-checked={part === p}
                  onClick={() => setPart(p)}
                >
                  {part === p ? '✓ ' : ''}
                  {p}
                </button>
              ))}
            </div>
            <h3 id="did-title">What did you do?</h3>
            <ul className="coach-checks" aria-labelledby="did-title">
              {ACTIONS.map((a) => (
                <li key={a}>
                  <label className="coach-check">
                    <input
                      type="checkbox"
                      checked={actions.includes(a)}
                      onChange={() => setActions((list) => toggle(list, a))}
                    />
                    {a}
                  </label>
                </li>
              ))}
            </ul>
            <div className="coach-callout">
              <Icon name="sms" size={20} />
              <p>
                {first}&apos;s family is texted when you send, through their notification settings.
                Call the desk now if it&apos;s serious.
              </p>
            </div>
            <button
              type="button"
              className="coach-voice"
              disabled={!VOICE_NOTES_AVAILABLE}
              aria-describedby="voice-proposed"
            >
              <Icon name="campaign" size={20} />
              Add a voice note
              <span className="coach-tag" id="voice-proposed">
                ◷ Proposed
              </span>
            </button>
            {typing ? (
              <label className="coach-note">
                A short note (optional)
                <textarea
                  className="coach-textarea"
                  value={note}
                  maxLength={2000}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
            ) : (
              <button type="button" className="coach-showall" onClick={() => setTyping(true)}>
                Type a note instead
              </button>
            )}
          </>
        ) : null}

        {step === 'head' && child ? (
          <>
            <h3 id="signs-title">Concussion check</h3>
            <p className="coach-note">
              Tick what you see. Any sign: {first} sits out and goes home with an adult. Call 911 if{' '}
              {first} lost consciousness.
            </p>
            <ul className="coach-checks" aria-labelledby="signs-title">
              {CONCUSSION_SIGNS.map((s) => (
                <li key={s}>
                  <label className="coach-check">
                    <input
                      type="checkbox"
                      checked={signs.includes(s)}
                      onChange={() => setSigns((list) => toggle(list, s))}
                    />
                    {s}
                  </label>
                </li>
              ))}
            </ul>
            {signs.length > 0 ? (
              <div className="coach-callout" data-tone="warning" role="status">
                <Icon name="warning" size={20} />
                <p>{first} sits out for the rest of the session. Tell the adult at pickup.</p>
              </div>
            ) : null}
          </>
        ) : null}

        {step === 'review' && child && part ? (
          <>
            <h3>Check and send</h3>
            <ul className="coach-review" aria-label="The report">
              <li>
                <span>Where</span>
                <b>{part}</b>
              </li>
              <li>
                <span>What you did</span>
                <b>{actions.length > 0 ? actions.join(', ') : 'Nothing ticked'}</b>
              </li>
              {head ? (
                <li>
                  <span>Concussion signs</span>
                  <b>{signs.length > 0 ? `${signs.length} seen` : 'None seen'}</b>
                </li>
              ) : null}
              {note.trim() ? (
                <li>
                  <span>Note</span>
                  <b>{note.trim()}</b>
                </li>
              ) : null}
              <li>
                <span>When</span>
                <b>{clockText(at, zone)}</b>
              </li>
            </ul>
            <p className="coach-note">
              Sending texts {first}&apos;s family, puts the report on the manager&apos;s Today and
              saves it to {first}&apos;s record. Facts only: no diagnosis.
            </p>
            {!online ? (
              <div className="coach-callout" data-tone="warning" role="status">
                <Icon name="wifi_off" size={20} />
                <p>Sending needs a connection. If it&apos;s urgent, call the desk now.</p>
              </div>
            ) : null}
            {error ? (
              <div className="coach-callout" data-tone="warning" role="alert">
                <Icon name="error" size={20} />
                <p>{error}</p>
              </div>
            ) : null}
          </>
        ) : null}

        {step === 'sent' && child ? (
          <>
            <ul className="coach-review" aria-label="What happens next">
              <li>
                <b>✓ {first}&apos;s family is told</b>
              </li>
              <li>
                <b>✓ On the manager&apos;s Today</b>
              </li>
              <li>
                <b>✓ Saved to {first}&apos;s record</b>
              </li>
            </ul>
            <div className="coach-actions">
              <button
                type="button"
                className="coach-primary"
                onClick={() => navigate('/workspace')}
              >
                Done
              </button>
            </div>
          </>
        ) : null}

        {step === 'what' || step === 'head' || step === 'review' ? (
          <div className="coach-actions">
            <button type="button" className="coach-secondary" onClick={back} disabled={busy}>
              Back
            </button>
            {step === 'review' ? (
              <button
                type="button"
                className="coach-primary"
                disabled={busy || !online}
                aria-busy={busy || undefined}
                onClick={() => void submit()}
              >
                {busy ? 'Sending…' : 'Send report'}
              </button>
            ) : (
              <button
                type="button"
                className="coach-primary"
                disabled={!part}
                onClick={() => setStep(step === 'what' && head ? 'head' : 'review')}
              >
                {step === 'what' && head ? 'Next: concussion check' : 'Next: review'}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ChildCard({
  child,
  title,
  location,
  time,
}: {
  child: RosterChild;
  title: string;
  location: string | null;
  time: string;
}) {
  const allergy = child.careKinds.includes('allergy');
  return (
    <div className="coach-card">
      <Avatar name={child.name} personKey={child.personId} size={44} decorative />
      <span className="coach-card-text">
        <b className="coach-card-name">{child.name}</b>
        <small>
          {title}
          {location ? ` · ${location}` : ''} · {time}
        </small>
      </span>
      {child.careKinds.length > 0 ? (
        <span className="coach-flag" data-tone={allergy ? 'danger' : 'info'}>
          {allergy ? '✕ allergy' : 'ℹ care'}
        </span>
      ) : null}
    </div>
  );
}
