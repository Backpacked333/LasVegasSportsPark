/**
 * S 3h Shared desk tablet, locked (redesign handoff; Proposed). Two halves on the night surface:
 *
 * - left, "Scan your pass": a scanner (or typed reference) keeps check-ins moving. The pass is
 *   resolved (`POST /v1/passes/scan`) and every person with a session today that is not checked
 *   in yet is checked in (`POST /v1/session-checkins`, one idempotency key per person and session).
 *   When every check-in is admitted the screen says "Checked in" with first names only; anything
 *   else (an unknown pass, a held check-in with an arrival issue, offline) says "Please wait for
 *   staff" and reveals nothing more: no care notes, no reasons, no family names.
 * - right, the PIN: the signed-in person's face and name, when it locked and the device's name,
 *   four dots, a 52 px keypad (and the digit keys), "Switch user". Five wrong tries block the
 *   keypad for a minute, shown as a countdown.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useKeyedCommands } from '../../features/operations/commands';
import { useApp, useNow } from '../../providers/AppProviders';
import { Avatar } from '../../ui/Avatar';
import { Icon } from '../../ui/Icon';
import { useFacilityChoices } from '../FacilitySwitcher';
import type { LockApi } from './LockProvider';
import { DEVICE_NAME_KEY, MAX_TRIES, PIN_LENGTH } from './pin';
import './lock.css';

/** How long a check-in answer stays before the screen is ready for the next family. */
export const ANSWER_MS = 4_000;

type Answer = { kind: 'checked_in'; names: string[] } | { kind: 'wait' } | null;

function CheckInHalf() {
  const { facilityId, online } = useApp();
  const choices = useFacilityChoices();
  const facility = facilityId ?? choices.options[0] ?? null;
  const scan = useApiCommand('post', '/passes/scan');
  const checkins = useKeyedCommands();
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer>(null);

  useEffect(() => {
    if (!answer) return;
    const id = setTimeout(() => setAnswer(null), ANSWER_MS);
    return () => clearTimeout(id);
  }, [answer]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = reference.trim();
    if (!value || busy) return;
    setReference('');
    if (!online || !facility) {
      setAnswer({ kind: 'wait' });
      return;
    }
    setBusy(true);
    try {
      const result = await scan.submit({ body: { reference: value, facilityId: facility } });
      scan.reset();
      const due = result.people.flatMap((person) =>
        person.activities
          .filter((a) => a.checkin === null)
          .map((a) => ({ person, activity: a.activity })),
      );
      if (due.length === 0) {
        setAnswer({ kind: 'wait' });
        return;
      }
      const names = new Set<string>();
      let allAdmitted = true;
      for (const { person, activity } of due) {
        const ref =
          activity.type === 'session' && activity.offeringId && activity.sessionId
            ? {
                type: 'session' as const,
                offeringId: activity.offeringId,
                sessionId: activity.sessionId,
              }
            : { type: 'event' as const, eventId: activity.eventId ?? activity.id };
        const done = await checkins
          .run(`${person.personId}:${activity.id}`, 'post', '/session-checkins', {
            body: {
              personId: person.personId,
              activity: ref,
              visitId: person.visitId ?? undefined,
            },
          })
          .catch(() => undefined);
        if (done?.status === 'admitted') names.add(person.givenName);
        else allAdmitted = false;
      }
      setAnswer(
        allAdmitted && names.size > 0
          ? { kind: 'checked_in', names: [...names] }
          : { kind: 'wait' },
      );
    } catch {
      scan.reset();
      setAnswer({ kind: 'wait' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lock-scan" aria-labelledby="lock-scan-title">
      <span className="lock-kicker">Families can still check in</span>
      <h2 id="lock-scan-title">Scan your pass</h2>
      <form className="lock-scan-box" onSubmit={(e) => void submit(e)} data-answer={answer?.kind}>
        {answer?.kind === 'checked_in' ? (
          <p className="lock-answer" role="status" data-tone="success">
            <span className="lock-answer-glyph" aria-hidden="true">
              ✓
            </span>
            Checked in: {answer.names.join(', ')}
          </p>
        ) : answer?.kind === 'wait' ? (
          <p className="lock-answer" role="status" data-tone="wait">
            <span className="lock-answer-glyph" aria-hidden="true">
              ◷
            </span>
            Please wait for staff
          </p>
        ) : (
          <span className="lock-scan-frame" aria-hidden="true">
            <Icon name="qr_code_2" size={56} />
          </span>
        )}
        <label className="visually-hidden" htmlFor="lock-scan-input">
          Pass reference
        </label>
        <input
          id="lock-scan-input"
          className="lock-scan-input"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Scan, or type the pass reference"
          autoComplete="off"
          disabled={busy}
        />
      </form>
      <p className="lock-foot">
        Only check-in works while locked. Anything that isn't cleared waits for staff.
      </p>
    </section>
  );
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function PinHalf({ lock }: { lock: LockApi }) {
  const { session, preferences } = useApp();
  const now = useNow(1_000);
  const me = useApiQuery({ path: '/me', enabled: session.status === 'signed_in' });
  const person = me.data?.person ?? null;
  const name = [person?.givenName, person?.familyName].filter(Boolean).join(' ') || 'Signed in';
  const deviceName = preferences.get(DEVICE_NAME_KEY) ?? 'This tablet';
  const [digits, setDigits] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const blockedFor = lock.state.blockedUntil
    ? new Date(lock.state.blockedUntil).getTime() - now.getTime()
    : 0;
  const blocked = blockedFor > 0;
  const lockedAt = lock.state.lockedAt
    ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
        .format(new Date(lock.state.lockedAt))
        .replace(/\s?[AP]M$/, '')
    : null;
  const pending = useRef(false);

  const press = (digit: string) => {
    if (blocked || checking || pending.current) return;
    setMessage(null);
    setDigits((current) => (current.length < PIN_LENGTH ? current + digit : current));
  };
  const erase = () => setDigits((current) => current.slice(0, -1));

  useEffect(() => {
    if (digits.length !== PIN_LENGTH || pending.current) return;
    pending.current = true;
    setChecking(true);
    void lock
      .unlock(digits)
      .then((result) => {
        if (result === 'wrong') {
          const left = MAX_TRIES - lock.state.failures - 1;
          setMessage(
            `Wrong PIN. ${left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}`,
          );
        } else if (result === 'blocked') {
          setMessage('Too many wrong tries.');
        }
      })
      .finally(() => {
        pending.current = false;
        setChecking(false);
        setDigits('');
      });
  }, [digits, lock]);

  // Digit keys work too, unless the scan field has focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        press(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        erase();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <section className="lock-pin" aria-labelledby="lock-pin-name">
      <Avatar name={name} personKey={person?.id} size={88} ring decorative />
      <h2 id="lock-pin-name" className="lock-name">
        {name}
      </h2>
      <p className="lock-meta">
        {lockedAt ? `Locked at ${lockedAt} · ` : ''}
        {deviceName}
      </p>
      <div
        className="lock-dots"
        role="img"
        aria-label={`${digits.length} of ${PIN_LENGTH} digits entered`}
        data-testid="pin-dots"
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <i key={i} data-filled={i < digits.length || undefined} />
        ))}
      </div>
      <p className="lock-message" role="status" aria-live="polite">
        {blocked ? `Too many wrong tries. Try again in ${clock(blockedFor)}.` : message}
      </p>
      <div className="lock-keypad" role="group" aria-label="PIN keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            className="lock-key"
            disabled={blocked || checking}
            onClick={() => press(d)}
          >
            {d}
          </button>
        ))}
        <span aria-hidden="true" />
        <button
          type="button"
          className="lock-key"
          disabled={blocked || checking}
          onClick={() => press('0')}
        >
          0
        </button>
        <button
          type="button"
          className="lock-key lock-key-erase"
          aria-label="Delete a digit"
          disabled={digits.length === 0 || checking}
          onClick={erase}
        >
          <Icon name="arrow_back" size={22} />
        </button>
      </div>
      <button type="button" className="lock-switch" onClick={() => void lock.switchUser()}>
        Switch user
      </button>
    </section>
  );
}

export function LockScreen({ lock }: { lock: LockApi }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.lock-key')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="lock-screen"
      role="dialog"
      aria-modal="true"
      aria-label="Locked: enter your PIN"
      data-testid="lock-screen"
    >
      <CheckInHalf />
      <PinHalf lock={lock} />
    </div>
  );
}
