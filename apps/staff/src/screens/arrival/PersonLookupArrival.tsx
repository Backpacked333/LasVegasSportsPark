/**
 * SCR-S-28 "look a person up" (SPK-ENTRY-001, SPK-ENTRY-003, SPK-ENTRY-004, SPK-ENTRY-006,
 * SPK-IAM-002, §4.14): arrival and check-in for a person without their pass.
 *
 * - The person is found with the staff person search (`GET /v1/people`, as the viewer's role
 *   allows; names, kind and status only). Nothing is recorded by finding someone.
 * - Facility arrival (`POST /v1/visits` without a pass) and session check-in
 *   (`POST /v1/session-checkins`) stay separate records and separate intents (§4.9), both chosen
 *   explicitly: nothing is preselected (SPK-AT-015). The visitor category is chosen; which ones a
 *   facility uses is DEC-071 (pending).
 * - The session comes from today's sessions at the facility (`GET /v1/sessions`, facility time
 *   zone). Whether the person takes part is the API's evaluation: a check-in without a
 *   participation basis is held with the issue stated (SPK-ENTRY-004), never a fabricated
 *   enrollment (SPK-ENTRY-006). A held check-in is actionable in place: "Check again"
 *   (`POST /v1/session-checkins/{id}/recheck` with its revision, its own intent), as from a scan.
 * - Recording for a looked-up person needs a connection: the offline queue works from a pass scan
 *   (the scan is the roster snapshot, §4.15).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useKeyedCommands } from '../../features/operations/commands';
import { CommandError, CommandSuccess } from '../../features/operations/feedback';
import { SelectField } from '../../features/operations/fields';
import { formatRange } from '../../features/operations/format';
import { VISITOR_CATEGORY_LABEL } from '../../features/operations/labels';
import {
  PersonSearch,
  personLabel,
  type PersonSearchResult,
} from '../../features/operations/PersonSearch';
import {
  sessionActivity,
  sessionTitle,
  useTodaySessions,
} from '../../features/operations/sessions';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { CheckinOutcome } from './CheckinOutcome';

type Category = keyof typeof VISITOR_CATEGORY_LABEL;
type RecordedVisits = Schema<'RecordedVisits'>;
type SessionCheckin = Schema<'SessionCheckin'>;

const CATEGORY_OPTIONS = (Object.keys(VISITOR_CATEGORY_LABEL) as Category[]).map((value) => ({
  value,
  label: VISITOR_CATEGORY_LABEL[value],
}));

export function PersonLookupArrival({
  facilityId,
  timezone,
  window,
}: {
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
}) {
  const [person, setPerson] = useState<PersonSearchResult | null>(null);
  return (
    <div className="ops-section" aria-labelledby="lookup-title">
      <h3 id="lookup-title">Find a person without a pass</h3>
      <p className="caption">
        Finding someone records nothing. Choose what to record for them below.
      </p>
      <PersonSearch label="Find a person" chooseLabel="Select" onChoose={setPerson} />
      {person ? (
        <LookedUpPerson
          key={person.id}
          person={person}
          facilityId={facilityId}
          timezone={timezone}
          window={window}
          onDone={() => setPerson(null)}
        />
      ) : null}
    </div>
  );
}

function LookedUpPerson({
  person,
  facilityId,
  timezone,
  window,
  onDone,
}: {
  person: PersonSearchResult;
  facilityId: string;
  timezone: string | null;
  window: { start: string; end: string } | null;
  onDone: () => void;
}) {
  const { online } = useApp();
  const name = personLabel(person);
  const commands = useKeyedCommands({ invalidate: [['api', '/facilities/{id}/occupancy']] });
  const [category, setCategory] = useState<Category | ''>('');
  const [categoryMissing, setCategoryMissing] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [sessionMissing, setSessionMissing] = useState(false);
  const sessions = useTodaySessions({ facilityId, window });
  const arrival = commands.outcome('lookup-visit');
  const visit = (arrival.data as RecordedVisits | undefined)?.visits.find(
    (v) => v.personId === person.id,
  );
  const checkinKey = `lookup-checkin|${sessionId}`;
  const checkin = commands.outcome(checkinKey);
  const recheckKey = `lookup-recheck|${sessionId}`;
  const recheck = commands.outcome(recheckKey);
  // The latest evaluation: a recheck's answer, else the check-in's own.
  const current = (recheck.data ?? checkin.data) as SessionCheckin | undefined;
  const chosenSession = (sessions.data ?? []).find((s) => s.sessionId === sessionId);

  const recordArrival = () => {
    if (!category) {
      setCategoryMissing(true);
      return;
    }
    setCategoryMissing(false);
    void commands.run('lookup-visit', 'post', '/visits', {
      body: { facilityId, arrivals: [{ personId: person.id, visitorCategory: category }] },
    });
  };
  const checkIn = () => {
    if (!chosenSession) {
      setSessionMissing(true);
      return;
    }
    setSessionMissing(false);
    void commands.run(checkinKey, 'post', '/session-checkins', {
      body: {
        personId: person.id,
        activity: sessionActivity(chosenSession),
        ...(visit ? { visitId: visit.id } : {}),
      },
    });
  };

  const sessionsUnavailable =
    sessions.error && (sessions.error.isPermissionRestriction || sessions.error.isNotFound);

  return (
    <section className="ops-section" aria-label={`Arrival for ${name}`}>
      <h4>{name}</h4>
      <p className="caption">{person.kind === 'child' ? 'Child' : 'Adult'}</p>
      {!online ? (
        <StateView
          variant="unavailable"
          title="Needs a connection"
          description="Recording for a person found by search needs a connection. Scan their pass to queue an arrival on this device."
        />
      ) : null}
      {visit ? (
        <CommandSuccess label="Arrived" />
      ) : (
        <div className="ops-form" role="group" aria-label={`Facility arrival for ${name}`}>
          <SelectField
            label={`Visitor category for ${name}`}
            value={category}
            onChange={(v) => setCategory(v as Category | '')}
            options={CATEGORY_OPTIONS}
            placeholder="Choose a category"
            hint="Which categories this facility uses is pending (DEC-071)."
            error={categoryMissing ? 'Choose a visitor category.' : undefined}
          />
          <div className="ops-actions">
            <Button busy={arrival.status === 'pending'} disabled={!online} onClick={recordArrival}>
              Record arrival
            </Button>
          </div>
          {arrival.status === 'error' && arrival.error ? (
            <CommandError error={arrival.error} onRetry={recordArrival} subject="This person" />
          ) : null}
        </div>
      )}
      <div className="ops-form" role="group" aria-label={`Session check-in for ${name}`}>
        {sessionsUnavailable ? (
          <StateView
            variant="unavailable"
            title="Sessions not available"
            description="Today's sessions at this facility are not available to you, so a check-in cannot be chosen here."
          />
        ) : (
          <>
            <SelectField
              label={`Session to check ${name} in to`}
              value={sessionId}
              onChange={(v) => {
                setSessionId(v);
                setSessionMissing(false);
              }}
              placeholder={
                sessions.data === undefined
                  ? sessions.error
                    ? 'Sessions could not be loaded'
                    : 'Loading sessions…'
                  : sessions.data.length === 0
                    ? 'No session today'
                    : 'Choose a session'
              }
              disabled={sessions.data === undefined || checkin.status === 'success'}
              options={(sessions.data ?? []).map((s) => ({
                value: s.sessionId,
                label: `${sessionTitle(s)}, ${formatRange(s.scheduledStart, s.scheduledEnd, s.timezone ?? timezone)}`,
              }))}
              hint="The service checks whether the person takes part and states any issue."
              error={sessionMissing ? 'Choose the session they attend.' : undefined}
            />
            {sessions.error ? (
              <StateView
                variant="error"
                error={sessions.error}
                onRetry={() => void sessions.refetch()}
              />
            ) : null}
            <LoadMore pages={sessions} label="sessions" />
            {checkin.status === 'success' && current && chosenSession ? (
              <>
                <CheckinOutcome
                  checkin={current}
                  title={sessionTitle(chosenSession)}
                  busy={recheck.status === 'pending'}
                  onRecheck={
                    online
                      ? () =>
                          void commands.run(recheckKey, 'post', '/session-checkins/{id}/recheck', {
                            path: { id: current.id },
                            body: { expectedRevision: current.revision },
                          })
                      : undefined
                  }
                />
                {recheck.status === 'error' && recheck.error ? (
                  <CommandError error={recheck.error} subject="This check-in" />
                ) : null}
              </>
            ) : (
              <div className="ops-actions">
                <Button
                  variant="secondary"
                  busy={checkin.status === 'pending'}
                  disabled={!online}
                  onClick={checkIn}
                >
                  Check in
                </Button>
              </div>
            )}
            {checkin.status === 'error' && checkin.error ? (
              <CommandError error={checkin.error} onRetry={checkIn} subject="This check-in" />
            ) : null}
          </>
        )}
      </div>
      <div className="ops-actions">
        <Button variant="secondary" onClick={onDone}>
          Find someone else
        </Button>
      </div>
      {visit && checkin.status !== 'success' ? (
        <p className="caption">
          <StatusBadge tone="info" label="Arrival recorded" /> A session check-in is a separate
          record; choose a session if they attend one.
        </p>
      ) : null}
    </section>
  );
}
