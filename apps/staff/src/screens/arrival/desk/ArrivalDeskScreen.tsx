/**
 * Staff S 2a / S 3c / S 3d: the arrival desk at the front-desk tablet (SPK-ENTRY-001 to
 * SPK-ENTRY-004, SPK-AT-015, SPK-AT-018, §4.15).
 *
 * - Scan a pass (`POST /v1/passes/scan`) or find the family by name, phone or pass reference
 *   (`GET /v1/people`, then `POST /v1/arrival-lookups`): the whole household comes up with one
 *   answer per person, "✓ Cleared" or "✕ Not cleared", each with its session, from the arrival
 *   checks the API returns with the scan. Nothing is recorded by opening a family (SPK-ENTRY-003).
 * - A blocking waiver is fixed on the spot: "Dana signs on this tablet" hands the tablet to the
 *   parent (S 3c, `TabletSign`); once staff take it back the family is opened again, so the
 *   verdict re-checks by itself.
 * - The primary button checks in everyone cleared, named on the button ("Check in Maya and Leo").
 *   A cleared person can be left out ("Not today"): only the people and sessions actually
 *   attending are recorded (SPK-AT-015). Online: the facility arrival for those not on site yet
 *   (`POST /v1/visits`, one intent), one session check-in each (`POST /v1/session-checkins`,
 *   its own intent) and, once admitted, the attendance observation "present" for the session
 *   (`POST /v1/attendance-observations`, its own intent): separate records (SPK-ENTRY-001), the
 *   same two observations the offline path queues, so "Sessions now" counts them either way.
 * - Offline (S 3d) the desk never stops: each check-in is queued on the device as its facility
 *   arrival and its attendance observation against the scan's roster snapshot (§4.15), counted on
 *   the navigation's Arrival badge and listed under "Waiting to sync", and sent in order once the
 *   connection is back (`OfflineQueueProvider`).
 * - Success is one big green answer with faces (S 3d). It clears itself after 3 s for the next
 *   family; a tap holds it.
 * - Care notes show as a red pill on the person's card; tapping it opens the note, read again
 *   with `GET /v1/people/{id}/care-notes` (protected, every read audited; role-gated: a role that
 *   may not read care notes sees none).
 */
import { ApiError } from '@sportspark/api-client';
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import { useApiPages } from '../../../api/useApiPages';
import { useApiQuery } from '../../../api/useApiQuery';
import { activityFromDetail } from '../../../features/operations/activity';
import { useKeyedCommands } from '../../../features/operations/commands';
import { useOperatingFacility } from '../../../features/operations/context';
import { ChooseFacility, CommandError } from '../../../features/operations/feedback';
import { useOfflineQueue } from '../../../features/operations/offline/OfflineQueueProvider';
import { serviceClockOf } from '../../../features/operations/offline/clock';
import { useQueuedCheckinCount } from '../../../features/operations/offline/deskCheckins';
import { PERSON_SEARCH_MIN } from '../../../features/operations/PersonSearch';
import { useTodaySessions } from '../../../features/operations/sessions';
import { useSigners } from '../../../features/waivers/WaiverAcceptanceForm';
import { useApi, useApp, useNow } from '../../../providers/AppProviders';
import { Icon } from '../../../ui/Icon';
import { CameraScanner } from '../CameraScanner';
import { sessionPlace } from '../SessionsNow';
import '../arrival.css';
import './desk.css';
import { DeskAvatar } from './DeskAvatar';
import { DeskSessionsNow, WaitingToSync } from './DeskSide';
import {
  ageOn,
  blockerWords,
  deskClock,
  fromLookup,
  fromScan,
  fullName,
  rememberNames,
  signableWaiver,
  verdictOf,
  type ArrivalLookup,
  type DeskOpening,
  type ScanActivity,
  type ScanPerson,
  type Verdict,
} from './deskModel';
import { TabletSign, type SignRequest } from './TabletSign';

/** How long the green answer stays before the desk is ready for the next family. */
export const CHECKED_IN_HOLD_MS = 3_000;

/** A typed value that reads as a pass reference rather than a name or phone number. */
export function looksLikePassReference(value: string): boolean {
  const v = value.trim();
  return v.startsWith('spp_') || (v.length >= 16 && !/\s/.test(v) && !/^\+?\d+$/.test(v));
}

interface CheckedIn {
  people: { person: ScanPerson; activity: ScanActivity }[];
  offline: boolean;
}

export function ArrivalDeskScreen() {
  const facility = useOperatingFacility();
  const { online, services } = useApp();
  const waiting = useQueuedCheckinCount();
  const [opening, setOpening] = useState<{ value: DeskOpening; receivedAt: Date } | null>(null);
  const [checkedIn, setCheckedIn] = useState<CheckedIn | null>(null);
  const [signing, setSigning] = useState<SignRequest | null>(null);
  /** People who signed on the tablet during this family, and when (shown on the green answer). */
  const [signedAt, setSignedAt] = useState<Record<string, string>>({});
  const [lastScanAt, setLastScanAt] = useState<string | null>(null);
  const [opener, setOpener] = useState<{ pending: boolean; error: ApiError | null }>({
    pending: false,
    error: null,
  });
  const api = useApi();
  const input = useRef<HTMLInputElement>(null);

  const open = async (how: DeskOpening['reopen']) => {
    if (!facility.facilityId) return;
    setOpener({ pending: true, error: null });
    try {
      const value =
        how.kind === 'pass'
          ? fromScan(
              await api.post('/passes/scan', {
                body: { reference: how.reference, facilityId: facility.facilityId },
                intent: api.newIntent(),
              }),
              how.reference,
            )
          : fromLookup(
              await api.post('/arrival-lookups', {
                body: { facilityId: facility.facilityId, holder: how.holder },
                intent: api.newIntent(),
              }),
            );
      rememberNames(value.people);
      setOpening({ value, receivedAt: services.now() });
      setCheckedIn(null);
      setLastScanAt(value.openedAt);
      setOpener({ pending: false, error: null });
    } catch (cause) {
      setOpener({
        pending: false,
        error: cause instanceof ApiError ? cause : null,
      });
    }
  };

  const clear = () => {
    setOpening(null);
    setCheckedIn(null);
    setSignedAt({});
    setOpener({ pending: false, error: null });
    input.current?.focus();
  };

  if (!facility.facilityId) {
    return (
      <section className="desk" aria-labelledby="desk-title">
        <h1 id="desk-title" className="ops-sr">
          Arrival desk
        </h1>
        {facility.loading ? (
          <div className="desk-card desk-skeleton-block" aria-busy="true">
            Loading your facilities…
          </div>
        ) : (
          <ChooseFacility purpose="scan passes and check families in" />
        )}
      </section>
    );
  }

  return (
    <section className="desk" aria-labelledby="desk-title">
      <h1 id="desk-title" className="ops-sr">
        Arrival desk
      </h1>
      {!online ? (
        <div className="desk-offline" role="status">
          <Icon name="cloud_off" />
          <span>
            <b>Offline.</b> Check-ins are saved on this tablet and sent when Wi-Fi is back. A family
            opened before the drop can still be checked in.
          </span>
          {waiting > 0 ? <b className="desk-offline-count">{waiting} waiting</b> : null}
        </div>
      ) : null}
      <div className="desk-grid">
        <div className="desk-main">
          {checkedIn ? (
            <>
              <CheckedInAnswer
                result={checkedIn}
                timezone={facility.timezone}
                signedAt={signedAt}
                onNext={clear}
              />
              <button type="button" className="desk-next" onClick={clear}>
                <span className="desk-next-frame" aria-hidden="true">
                  <Icon name="qr_code_2" size={30} />
                </span>
                Next: scan a pass or search
              </button>
            </>
          ) : (
            <>
              <DeskScanner
                inputRef={input}
                online={online}
                busy={opener.pending}
                error={opener.error}
                lastScanAt={lastScanAt}
                timezone={facility.timezone}
                onReference={(reference) => void open({ kind: 'pass', reference })}
                onHolder={(holder) => void open({ kind: 'lookup', holder })}
                onTyping={() => opener.error && setOpener({ pending: false, error: null })}
              />
              {opener.pending && !opening ? (
                <div className="desk-card desk-household desk-skeleton-block" aria-busy="true">
                  Opening the family…
                </div>
              ) : opening ? (
                <Household
                  key={opening.value.openedAt}
                  opening={opening.value}
                  receivedAt={opening.receivedAt}
                  facilityId={facility.facilityId}
                  timezone={facility.timezone}
                  window={facility.window}
                  rechecking={opener.pending}
                  onSign={setSigning}
                  onClear={clear}
                  onCheckedIn={setCheckedIn}
                />
              ) : (
                <div className="desk-card desk-household desk-empty">
                  <Icon name="family_restroom" size={32} />
                  <p>Scan a pass or search by name. The family comes up here.</p>
                </div>
              )}
            </>
          )}
        </div>
        <aside className="desk-side" aria-label="At the facility now">
          <WaitingToSync timezone={facility.timezone} />
          <DeskSessionsNow
            facilityId={facility.facilityId}
            timezone={facility.timezone}
            window={facility.window}
          />
          <Link className="desk-more desk-classic" to="/arrival/select">
            Record arrivals one by one
          </Link>
        </aside>
      </div>
      {signing ? (
        <TabletSign
          request={signing}
          timezone={facility.timezone}
          onHandBack={() => setSigning(null)}
          onSigned={(ids) => {
            const at = services.now().toISOString();
            setSignedAt((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, at])) }));
            setSigning(null);
            // The verdict re-checks by itself: the family is opened again.
            if (opening) void open(opening.value.reopen);
          }}
        />
      ) : null}
    </section>
  );
}

function DeskScanner({
  inputRef,
  online,
  busy,
  error,
  lastScanAt,
  timezone,
  onReference,
  onHolder,
  onTyping,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  online: boolean;
  busy: boolean;
  error: ApiError | null;
  lastScanAt: string | null;
  timezone: string | null;
  onReference: (reference: string) => void;
  onHolder: (holder: ArrivalLookup['holder']) => void;
  onTyping: () => void;
}) {
  const [value, setValue] = useState('');
  const [term, setTerm] = useState('');
  const api = useApi();
  const [picking, setPicking] = useState<string | null>(null);
  const results = useApiPages({
    path: '/people',
    request: { query: { query: term, limit: 8 } },
    enabled: term.length >= PERSON_SEARCH_MIN,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (looksLikePassReference(v)) {
      setTerm('');
      onReference(v);
      setValue('');
      return;
    }
    setTerm(v.slice(0, 100));
  };
  const pick = async (personId: string) => {
    setPicking(personId);
    try {
      // The family's household when they have one, otherwise the person and those they may view.
      const authority = await api.get('/people/{id}/authority', { path: { id: personId } });
      const household = authority.households[0];
      onHolder(
        household ? { kind: 'household', householdId: household.id } : { kind: 'person', personId },
      );
    } catch {
      onHolder({ kind: 'person', personId });
    } finally {
      setPicking(null);
      setTerm('');
      setValue('');
    }
  };
  const passError = error && (error.isNotFound || error.code === 'RESOURCE_CONFLICT');
  return (
    <section className="desk-scanner" aria-labelledby="desk-scan-title">
      <div className="desk-scanner-frame" aria-hidden="true">
        <span className="desk-scanner-box">
          <Icon name="qr_code_2" size={40} />
        </span>
        <i className="desk-scanner-line" />
      </div>
      <div className="desk-scanner-body">
        <h2 id="desk-scan-title">Scan a pass or search</h2>
        <form className="desk-search" role="search" onSubmit={submit}>
          <Icon name="search" size={22} />
          <input
            ref={inputRef}
            aria-label="Name, phone or pass reference"
            placeholder="Name, phone or pass reference"
            value={value}
            autoComplete="off"
            disabled={!online}
            onChange={(e) => {
              setValue(e.target.value);
              onTyping();
            }}
          />
          {busy ? <span className="button-spinner" aria-label="Opening" /> : null}
        </form>
        <span className="desk-scanner-status">
          {online
            ? `Reader ready · camera when available${
                lastScanAt ? ` · last scan ${deskClock(lastScanAt, timezone, true)}` : ''
              }`
            : 'Offline · opening a new family needs Wi-Fi'}
        </span>
        <CameraScanner
          disabled={!online || busy}
          onDetected={(reference) => onReference(reference)}
        />
        {error ? (
          <p className="desk-scan-error" role="alert">
            {passError
              ? error.code === 'RESOURCE_CONFLICT'
                ? 'This pass has been revoked. Search by name instead.'
                : 'Pass not recognised. Search by name instead.'
              : 'The family could not be opened. Try again.'}
            <span className="caption"> Code {error.code}</span>
          </p>
        ) : null}
        {term ? (
          <div className="desk-results" aria-label="People found">
            {results.data === undefined ? (
              results.error ? (
                <p className="caption">
                  {results.error.isPermissionRestriction
                    ? 'Searching people is not available to your role.'
                    : `Search failed. Code ${results.error.code}.`}
                </p>
              ) : (
                <p className="caption" aria-busy="true">
                  Searching…
                </p>
              )
            ) : results.data.length === 0 ? (
              <p className="caption">Nobody found for “{term}”.</p>
            ) : (
              <ul>
                {results.data.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={picking !== null}
                      onClick={() => void pick(p.id)}
                      aria-label={`Open ${p.givenName} ${p.familyName}`}
                    >
                      <DeskAvatar
                        personId={p.id}
                        name={`${p.givenName} ${p.familyName}`}
                        size={30}
                      />
                      <b>
                        {p.givenName} {p.familyName}
                      </b>
                      <span className="caption">{p.kind === 'child' ? 'Child' : 'Adult'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Household({
  opening,
  receivedAt,
  facilityId,
  timezone,
  window,
  rechecking,
  onSign,
  onClear,
  onCheckedIn,
}: {
  opening: DeskOpening;
  receivedAt: Date;
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
  rechecking: boolean;
  onSign: (request: SignRequest) => void;
  onClear: () => void;
  onCheckedIn: (result: CheckedIn) => void;
}) {
  const { online, services } = useApp();
  const queue = useOfflineQueue();
  const now = useNow(30_000);
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const commands = useKeyedCommands({
    invalidate: [
      ['api', '/facilities/{id}/occupancy'],
      ['api', '/attendance'],
    ],
  });
  const sessions = useTodaySessions({ facilityId, window });
  const placeOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions.data ?? []) {
      const place = sessionPlace(s);
      if (place) map.set(s.sessionId, place);
    }
    return map;
  }, [sessions.data]);
  // One roster snapshot per opened family: offline check-ins are queued against it (§4.15).
  const roster = useMemo(
    () => ({
      snapshot: queue.newSnapshot(opening.openedAt),
      clock: serviceClockOf(opening.openedAt, receivedAt),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one snapshot per opening
    [opening.openedAt],
  );

  const verdicts = opening.people.map((person) => ({ person, verdict: verdictOf(person, now) }));
  const withActivity = verdicts.filter((v) => v.verdict.kind !== 'no_activity');
  const others = verdicts.filter((v) => v.verdict.kind === 'no_activity');
  const toCheckIn = withActivity.filter(
    (v): v is { person: ScanPerson; verdict: Extract<Verdict, { kind: 'cleared' }> } =>
      v.verdict.kind === 'cleared' &&
      !excluded[v.person.personId] &&
      commands.outcome(`checkin|${v.person.personId}`).status !== 'success',
  );
  const notCleared = withActivity.filter((v) => v.verdict.kind === 'not_cleared');
  const holder =
    opening.people.find((p) => p.relation === 'holder') ??
    opening.people.find((p) => p.kind === 'adult') ??
    opening.people[0];
  const familyName = holder?.familyName ?? '';
  const nextHour = new Set(
    opening.people.flatMap((p) =>
      p.activities
        .filter((a) => {
          const start = new Date(a.scheduledStart).getTime();
          return start >= now.getTime() - 15 * 60_000 && start <= now.getTime() + 3_600_000;
        })
        .map((a) => a.activity.id),
    ),
  ).size;
  const opener =
    opening.source === 'pass'
      ? holder
        ? `Scanned ${holder.givenName}'s pass`
        : 'Scanned a pass'
      : 'Found by name';
  const maxAge = services.config.offlineRosterMaxAgeMs ?? null;
  const rosterTooOld = maxAge !== null && now.getTime() - receivedAt.getTime() > maxAge;

  const names = toCheckIn.map((v) => v.person.givenName);
  const buttonLabel =
    names.length === 0
      ? 'Nobody to check in'
      : names.length <= 2
        ? `Check in ${names.join(' and ')}`
        : `Check in ${names.length} people`;

  const checkIn = async () => {
    setProblem(null);
    const chosen = toCheckIn.map((v) => ({ person: v.person, activity: v.verdict.activity }));
    if (chosen.length === 0) return;
    if (!online) {
      if (rosterTooOld) {
        setProblem(
          'This family was opened too long ago to check in offline. Open it again once Wi-Fi is back.',
        );
        return;
      }
      queue.enqueue(
        chosen.flatMap(({ person, activity }) => {
          const ref = activityFromDetail(activity.activity);
          if (!ref) return [];
          const groupId = queue.newObservationId();
          const observedAt = roster.clock.at(services.now());
          return [
            ...(person.onSite
              ? []
              : [
                  {
                    item: {
                      kind: 'arrival' as const,
                      clientObservationId: queue.newObservationId(),
                      observedAt,
                      personId: person.personId,
                      visitorCategory: 'participant' as const,
                    },
                    facilityId,
                    snapshot: roster.snapshot,
                    context: 'Facility arrival',
                    groupId,
                  },
                ]),
            {
              item: {
                kind: 'attendance' as const,
                clientObservationId: queue.newObservationId(),
                observedAt,
                personId: person.personId,
                activity: ref,
                observedState: 'present' as const,
              },
              facilityId,
              snapshot: roster.snapshot,
              context: `Check-in · ${activity.title}`,
              purpose: 'desk_checkin' as const,
              groupId,
            },
          ];
        }),
      );
      onCheckedIn({ people: chosen, offline: true });
      return;
    }
    const visits: Record<string, string> = {};
    const arriving = chosen.filter(({ person }) => !person.onSite);
    if (arriving.length > 0) {
      const recorded = await commands.run('visits', 'post', '/visits', {
        body: {
          facilityId,
          ...(opening.passId ? { passId: opening.passId } : {}),
          arrivals: arriving.map(({ person }) => ({
            personId: person.personId,
            visitorCategory: 'participant' as const,
          })),
        },
      });
      if (!recorded) return;
      for (const v of recorded.visits) if (v.personId) visits[v.personId] = v.id;
    }
    const admitted: CheckedIn['people'] = [];
    for (const { person, activity } of chosen) {
      const ref = activityFromDetail(activity.activity);
      if (!ref) continue;
      const visitId = visits[person.personId] ?? person.visitId ?? undefined;
      const result = await commands.run(`checkin|${person.personId}`, 'post', '/session-checkins', {
        body: { personId: person.personId, activity: ref, ...(visitId ? { visitId } : {}) },
      });
      if (result?.status === 'admitted') {
        admitted.push({ person, activity });
        // The desk saw them arrive for the session: the attendance observation the offline path
        // queues too, so "Sessions now" and "Still expected" count them (its own intent).
        await commands.run(`present|${person.personId}`, 'post', '/attendance-observations', {
          body: { personId: person.personId, activity: ref, observedState: 'present' },
        });
      } else if (result) {
        setProblem(
          `${person.givenName} is held: ${result.issues
            .filter((i) => i.severity === 'blocking')
            .map((i) => blockerWords(i))
            .join(', ')}.`,
        );
      }
    }
    if (admitted.length === chosen.length) onCheckedIn({ people: admitted, offline: false });
  };

  const visitsError = commands.outcome('visits').error;
  const blockedFooter = notCleared
    .map(({ person, verdict }) =>
      verdict.kind === 'not_cleared'
        ? signableWaiver(verdict.blocking)
          ? `${person.givenName} can be checked in once the ${
              signableWaiver(verdict.blocking)?.code === 'missing_acknowledgment'
                ? 'form'
                : 'waiver'
            } is signed. It refreshes by itself.`
          : `${person.givenName} can't be checked in yet: ${blockerWords(verdict.blocking[0]!).toLowerCase()}.`
        : '',
    )
    .join(' ');

  return (
    <section
      className="desk-card desk-household"
      aria-labelledby="desk-household-title"
      aria-busy={rechecking || undefined}
    >
      <header className="desk-household-head">
        <Icon name="family_restroom" size={22} />
        <span>
          <b id="desk-household-title">{familyName} household</b>
          <span className="desk-household-sub">
            {opener} · {opening.people.length} {opening.people.length === 1 ? 'person' : 'people'} ·{' '}
            {nextHour} {nextHour === 1 ? 'activity' : 'activities'} in the next hour
          </span>
        </span>
        {rechecking ? <span className="desk-household-recheck">Checking again…</span> : null}
      </header>
      <div className="desk-people">
        {withActivity.length === 0 ? (
          <p className="caption desk-people-empty">
            Nobody here has a session at this facility today.
          </p>
        ) : null}
        {withActivity.map(({ person, verdict }) => (
          <PersonCard
            key={person.personId}
            person={person}
            verdict={verdict}
            household={opening.people}
            timezone={timezone}
            place={
              verdict.kind === 'no_activity'
                ? null
                : (placeOf.get(verdict.activity.activity.sessionId ?? '') ?? null)
            }
            excluded={!!excluded[person.personId]}
            onExclude={(value) => setExcluded((prev) => ({ ...prev, [person.personId]: value }))}
            outcomeError={commands.outcome(`checkin|${person.personId}`).error ?? null}
            onSign={onSign}
          />
        ))}
        {others.map(({ person }) => (
          <AdultRow key={person.personId} person={person} />
        ))}
      </div>
      {problem ? (
        <p className="desk-problem" role="alert">
          {problem}
        </p>
      ) : null}
      {visitsError ? (
        <CommandError
          error={visitsError}
          onRetry={() => void commands.resend('visits')}
          subject="The arrival"
        />
      ) : null}
      <footer className="desk-household-foot">
        <span className="caption">{blockedFooter}</span>
        <button type="button" className="desk-button desk-button-secondary" onClick={onClear}>
          Clear
        </button>
        <button
          type="button"
          className="desk-button desk-button-primary"
          disabled={toCheckIn.length === 0 || commands.anyPending}
          aria-busy={commands.anyPending || undefined}
          onClick={() => void checkIn()}
        >
          {commands.anyPending ? (
            <span className="button-spinner" aria-hidden="true" />
          ) : (
            <Icon name="how_to_reg" />
          )}
          {buttonLabel}
        </button>
      </footer>
    </section>
  );
}

function usePersonAge(person: ScanPerson): number | null {
  const now = useNow(3_600_000);
  const detail = useApiQuery({
    path: '/people/{id}',
    request: { path: { id: person.personId } },
    enabled: person.kind === 'child',
  });
  return ageOn(detail.data?.dateOfBirth, now);
}

function PersonCard({
  person,
  verdict,
  household,
  timezone,
  place,
  excluded,
  onExclude,
  outcomeError,
  onSign,
}: {
  person: ScanPerson;
  verdict: Verdict;
  household: ScanPerson[];
  timezone: string | null;
  place: string | null;
  excluded: boolean;
  onExclude: (value: boolean) => void;
  outcomeError: ApiError | null;
  onSign: (request: SignRequest) => void;
}) {
  const age = usePersonAge(person);
  const name = fullName(person);
  if (verdict.kind === 'no_activity') return null;
  const activity = verdict.activity;
  const tone = verdict.kind === 'not_cleared' ? 'danger' : excluded ? 'neutral' : 'success';
  const heading =
    verdict.kind === 'checked_in'
      ? '✓ Checked in'
      : verdict.kind === 'not_cleared'
        ? '✕ Not cleared'
        : excluded
          ? '● Not today'
          : '✓ Cleared';
  const when = `${deskClock(activity.scheduledStart, timezone)}${place ? ` · ${place}` : ''}`;
  return (
    <article className="desk-person" data-tone={tone} aria-label={`${name}: ${heading.slice(2)}`}>
      <header className="desk-person-head">
        <span className="desk-person-verdict">{heading}</span>
        <span className="desk-person-when">{when}</span>
      </header>
      <div className="desk-person-body">
        <span className="desk-person-who">
          <DeskAvatar personId={person.personId} name={name} />
          <span>
            <b className="desk-person-name">{name}</b>
            <span className="caption">
              {age !== null ? `${age} · ` : ''}
              {activity.title}
            </span>
          </span>
        </span>
        <CarePills person={person} />
        {verdict.kind === 'not_cleared' ? (
          <Blocker
            person={person}
            activity={activity}
            verdict={verdict}
            household={household}
            onSign={onSign}
          />
        ) : null}
        {verdict.kind === 'cleared' ? (
          <button
            type="button"
            className="desk-text-button desk-person-toggle"
            aria-pressed={excluded}
            onClick={() => onExclude(!excluded)}
          >
            {excluded ? `Include ${person.givenName}` : `Not today for ${person.givenName}`}
          </button>
        ) : null}
        {outcomeError ? (
          <CommandError error={outcomeError} subject={`${person.givenName}'s check-in`} />
        ) : null}
      </div>
    </article>
  );
}

function Blocker({
  person,
  activity,
  verdict,
  household,
  onSign,
}: {
  person: ScanPerson;
  activity: ScanActivity;
  verdict: Extract<Verdict, { kind: 'not_cleared' }>;
  household: ScanPerson[];
  onSign: (request: SignRequest) => void;
}) {
  const waiver = signableWaiver(verdict.blocking);
  const { signers, loaded } = useSigners(person.personId, waiver !== null);
  // A form or waiver is named by its title ("Liability waiver not signed").
  const form = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: waiver?.reference?.id ?? '' } },
    enabled: waiver?.code === 'missing_acknowledgment',
  });
  const adult = household.find(
    (p) => p.kind === 'adult' && signers.some((s) => s.value === p.personId),
  );
  return (
    <>
      <span className="desk-blocker">
        {waiver?.code === 'missing_acknowledgment' && form.data
          ? `${form.data.title} not signed`
          : blockerWords(verdict.blocking[0]!)}
      </span>
      {waiver ? (
        adult ? (
          <button
            type="button"
            className="desk-button desk-button-primary desk-sign"
            onClick={() => onSign({ person, activity, issue: waiver, household })}
          >
            <Icon name="draw" />
            {adult.givenName} signs on this tablet
          </button>
        ) : loaded ? (
          <span className="caption">
            Nobody here may sign for {person.givenName}. Their guardian has to sign.
          </span>
        ) : null
      ) : (
        <span className="caption">{verdict.blocking[0]!.message}</span>
      )}
    </>
  );
}

function CarePills({ person }: { person: ScanPerson }) {
  const [open, setOpen] = useState<string | null>(null);
  const notes = person.careNotes ?? [];
  if (notes.length === 0) return null;
  return (
    <span className="desk-care">
      {notes.map((n) => (
        <button
          key={n.id}
          type="button"
          className="desk-care-pill"
          aria-expanded={open === n.id}
          onClick={() => setOpen(open === n.id ? null : n.id)}
        >
          ✕ {n.kind === 'allergy' ? 'Allergy' : 'Care'}: {shortNote(n.body)}
        </button>
      ))}
      {open ? (
        <CareNoteDetail
          personId={person.personId}
          name={fullName(person)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </span>
  );
}

function shortNote(body: string): string {
  const first = body.split(/[.;\n]/)[0]?.trim() ?? body;
  return first.length > 28 ? `${first.slice(0, 27)}…` : first;
}

/** The person's care notes, read again on open: the read is protected and audited (§4.14). */
function CareNoteDetail({
  personId,
  name,
  onClose,
}: {
  personId: string;
  name: string;
  onClose: () => void;
}) {
  const notes = useApiQuery({
    path: '/people/{id}/care-notes',
    request: { path: { id: personId } },
  });
  return (
    <div className="desk-care-detail" role="dialog" aria-label={`Care notes for ${name}`}>
      {notes.data ? (
        <ul>
          {notes.data.notes.map((n) => (
            <li key={n.id}>
              <b>{n.kind === 'allergy' ? 'Allergy' : 'Care instruction'}:</b> {n.body}
            </li>
          ))}
        </ul>
      ) : notes.error ? (
        <p className="caption">
          {notes.error.isPermissionRestriction || notes.error.isNotFound
            ? 'Care notes are not shown to your role.'
            : `Care notes could not load. Code ${notes.error.code}.`}
        </p>
      ) : (
        <p className="caption" aria-busy="true">
          Reading the note…
        </p>
      )}
      <span className="caption">Protected: this view is recorded in the audit log.</span>
      <button type="button" className="desk-text-button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

const RELATION: Record<ScanPerson['relation'], string> = {
  holder: 'Pass holder',
  household_member: 'Household member',
  dependent: 'Dependent',
};

function AdultRow({ person }: { person: ScanPerson }) {
  const name = fullName(person);
  return (
    <div className="desk-adult">
      <DeskAvatar personId={person.personId} name={name} size={36} />
      <span className="desk-adult-text">
        <b>{name}</b>
        <span className="caption">
          {person.kind === 'adult' ? 'Adult' : 'Child'} · {RELATION[person.relation]}
          {person.onSite ? ' · on site' : ''}
        </span>
      </span>
      <span className="badge tone-neutral" data-tone="neutral">
        <span aria-hidden="true">●</span>
        <span className="badge-label">No activity</span>
      </span>
    </div>
  );
}

function CheckedInAnswer({
  result,
  timezone,
  signedAt,
  onNext,
}: {
  result: CheckedIn;
  timezone: string | null;
  signedAt: Record<string, string>;
  onNext: () => void;
}) {
  const [held, setHeld] = useState(false);
  // The latest "next family" without restarting the 3 s when the desk re-renders meanwhile.
  const next = useRef(onNext);
  next.current = onNext;
  useEffect(() => {
    if (held) return;
    const id = setTimeout(() => next.current(), CHECKED_IN_HOLD_MS);
    return () => clearTimeout(id);
  }, [held]);
  const names = result.people.map((p) => p.person.givenName).join(' and ');
  return (
    <section
      className="desk-done"
      data-offline={result.offline || undefined}
      aria-labelledby="desk-done-title"
      onClick={() => setHeld(true)}
    >
      <h2 id="desk-done-title">
        <Icon name="check_circle" size={44} />
        {result.offline ? 'Checked in · waiting to sync' : 'Checked in'}
      </h2>
      <p className="ops-sr" role="status">
        Checked in: {names}
        {result.offline ? '. Saved on this tablet; sent when Wi-Fi is back.' : '.'}
      </p>
      <ul className="desk-done-people">
        {result.people.map(({ person, activity }) => (
          <li key={person.personId}>
            <DeskAvatar personId={person.personId} name={fullName(person)} size={50} ring />
            <span>
              <b>{person.givenName}</b>
              <span>
                {activity.title} · {deskClock(activity.scheduledStart, timezone)}
                {signedAt[person.personId]
                  ? ` · waiver signed ${deskClock(signedAt[person.personId]!, timezone)}`
                  : ''}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="desk-done-foot">
        <Icon name="schedule" size={18} />
        {held ? (
          <>
            Staying on this family ·{' '}
            <button
              type="button"
              className="desk-done-next"
              onClick={(event) => {
                event.stopPropagation();
                onNext();
              }}
            >
              Next family
            </button>
          </>
        ) : (
          'Ready for the next family in 3 s · tap anywhere to stay'
        )}
      </p>
    </section>
  );
}
