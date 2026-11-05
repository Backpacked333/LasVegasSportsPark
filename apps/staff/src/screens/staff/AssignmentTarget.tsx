/**
 * SCR-S-33 the activity an assignment covers (SPK-STAFF-002, SPK-STAFF-003, SPK-SCHED-008).
 *
 * Staff choose the target instead of typing record ids:
 * - a session from `GET /v1/sessions` (CAT-01) at the selected facility over the next 14 days; the
 *   row carries its offering, so no offering id is asked for;
 * - an event, or a fixture, from `GET /v1/events` (the facility window): a fixture is the event
 *   competition scheduled for it (`sourceType` fixture, its `sourceId` the fixture), read with the
 *   API's `sourceType=fixture` filter; plain events leave fixture events and canceled events out.
 * Times are in the facility zone the rows carry. Each list is paged by the API's cursor and says
 * "nothing" only when no further page exists. A list the viewer may not read is shown as not
 * available; the record id stays available as a fallback ("Enter a record id instead"), and the
 * API still checks qualification, availability, overlaps and turnaround when proposing.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { useApiPages, type ApiPagesResult } from '../../api/useApiPages';
import { SelectField, TextField } from '../../features/operations/fields';
import { formatRange } from '../../features/operations/format';
import { sessionKey, sessionTitle } from '../../features/operations/sessions';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';

export type TargetType = 'fixture' | 'event' | 'session';

export interface ChosenTarget {
  targetType: TargetType;
  targetId: string;
  /** A session's offering (the sessions read carries it); null for fixtures and events. */
  offeringId: string | null;
  /** What the screen shows for the target (never only its id). */
  title: string;
  /** The activity's time in the facility zone, when known. */
  when: string | null;
}

type ScheduledEvent = Schema<'Event'>;

/** How far ahead the lists reach (`GET /v1/sessions` allows at most 31 days). */
export const TARGET_WINDOW_DAYS = 14;
const TARGET_PAGE = 50;
const eventKey = (e: ScheduledEvent) => e.id;

function useTargetWindow() {
  const now = useNow(60_000);
  const minute = Math.floor(now.getTime() / 60_000);
  return useMemo(() => {
    const at = minute * 60_000;
    return {
      start: new Date(at).toISOString(),
      end: new Date(at + TARGET_WINDOW_DAYS * 86_400_000).toISOString(),
    };
  }, [minute]);
}

export function AssignmentTargetPicker({
  targetType,
  facilityId,
  value,
  onChange,
  error,
}: {
  targetType: TargetType;
  facilityId: string | null;
  value: ChosenTarget | null;
  onChange: (target: ChosenTarget | null) => void;
  error?: string;
}) {
  // Without a facility there is no list to choose from: the record id is the only way. A typed
  // id stays on screen (never replaced by a list while the form would still send it).
  const [typedChosen, setTypedChosen] = useState(false);
  const [typedId, setTypedId] = useState('');
  const [typedOffering, setTypedOffering] = useState('');
  const typed = typedChosen || facilityId === null || typedId !== '';
  const emitTyped = (id: string, offering: string) =>
    onChange(
      id.trim()
        ? {
            targetType,
            targetId: id.trim(),
            offeringId: targetType === 'session' && offering.trim() ? offering.trim() : null,
            title: `The ${targetType} with this record id`,
            when: null,
          }
        : null,
    );
  const switchMode = () => {
    setTypedChosen(!typed);
    setTypedId('');
    setTypedOffering('');
    onChange(null);
  };
  return (
    <div className="ops-section" role="group" aria-label={`The ${targetType} to staff`}>
      {typed ? (
        <>
          <TextField
            label={`${targetType === 'session' ? 'Session' : targetType === 'event' ? 'Event' : 'Fixture'} record id`}
            value={typedId}
            onChange={(v) => {
              setTypedId(v);
              emitTyped(v, typedOffering);
            }}
            required
            hint="Only when the list does not show it; the service checks the record."
            error={error}
          />
          {targetType === 'session' ? (
            <TextField
              label="Offering record id"
              value={typedOffering}
              onChange={(v) => {
                setTypedOffering(v);
                emitTyped(typedId, v);
              }}
              hint="A session is named together with its offering."
            />
          ) : null}
        </>
      ) : facilityId === null ? null : targetType === 'session' ? (
        <SessionChoice facilityId={facilityId} value={value} onChange={onChange} error={error} />
      ) : (
        <EventChoice
          facilityId={facilityId}
          kind={targetType}
          value={value}
          onChange={onChange}
          error={error}
        />
      )}
      {facilityId === null ? null : (
        <div className="ops-actions">
          <Button variant="secondary" onClick={switchMode}>
            {typed ? 'Choose from the list instead' : 'Enter a record id instead'}
          </Button>
        </div>
      )}
      {facilityId === null ? (
        <p className="caption">
          Choose a facility in the header to list its sessions, events and fixtures.
        </p>
      ) : null}
    </div>
  );
}

function ChoiceList({
  pages,
  label,
  noun,
  options,
  value,
  onChange,
  error,
}: {
  pages: ApiPagesResult<unknown>;
  label: string;
  /** Plural noun for loading and empty states, e.g. "sessions". */
  noun: string;
  options: readonly { value: string; label: string; target: ChosenTarget }[];
  value: ChosenTarget | null;
  onChange: (target: ChosenTarget | null) => void;
  error?: string;
}) {
  if (pages.error && (pages.error.isPermissionRestriction || pages.error.isNotFound)) {
    return (
      <div>
        <StateView
          variant="unavailable"
          title={`The list of ${noun} is not available`}
          description={`Listing ${noun} is not available to you here. Enter the record id instead, or ask a scheduler.`}
        />
        <p className="caption">Error code: {pages.error.code}</p>
      </div>
    );
  }
  if (pages.data === undefined) {
    return pages.error ? (
      <StateView variant="error" error={pages.error} onRetry={() => void pages.refetch()} />
    ) : (
      <StateView variant="loading" label={noun} />
    );
  }
  const chosenListed = value !== null && options.some((o) => o.value === value.targetId);
  return (
    <>
      {options.length === 0 && !pages.hasNextPage ? (
        <StateView
          variant="empty"
          title={`No ${noun}`}
          description={`No ${noun.replace(/s$/, '')} at this facility in the next ${TARGET_WINDOW_DAYS} days. Enter the record id instead if it is later.`}
        />
      ) : (
        <SelectField
          label={label}
          value={chosenListed ? (value?.targetId ?? '') : ''}
          onChange={(id) => onChange(options.find((o) => o.value === id)?.target ?? null)}
          placeholder={options.length === 0 ? `None on the pages loaded so far` : 'Choose'}
          hint={`The next ${TARGET_WINDOW_DAYS} days at this facility, in its time zone.`}
          error={error}
          options={options.map((o) => ({ value: o.value, label: o.label }))}
        />
      )}
      {pages.error ? (
        <StateView variant="error" error={pages.error} onRetry={() => void pages.refetch()} />
      ) : null}
      <LoadMore pages={pages} label={noun} />
    </>
  );
}

function SessionChoice({
  facilityId,
  value,
  onChange,
  error,
}: {
  facilityId: string;
  value: ChosenTarget | null;
  onChange: (target: ChosenTarget | null) => void;
  error?: string;
}) {
  const window = useTargetWindow();
  const sessions = useApiPages({
    path: '/sessions',
    request: {
      query: {
        facilityId,
        from: window.start,
        to: window.end,
        status: 'scheduled',
        limit: TARGET_PAGE,
      },
    },
    keyOf: sessionKey,
  });
  const options = (sessions.data ?? []).map((s) => {
    const when = formatRange(s.scheduledStart, s.scheduledEnd, s.timezone);
    const title = sessionTitle(s);
    return {
      value: s.sessionId,
      label: `${title}, ${when}`,
      target: {
        targetType: 'session' as const,
        targetId: s.sessionId,
        offeringId: s.offeringId,
        title,
        when,
      },
    };
  });
  return (
    <ChoiceList
      pages={sessions}
      label="Session"
      noun="sessions"
      options={options}
      value={value}
      onChange={onChange}
      error={error}
    />
  );
}

function EventChoice({
  facilityId,
  kind,
  value,
  onChange,
  error,
}: {
  facilityId: string;
  kind: 'event' | 'fixture';
  value: ChosenTarget | null;
  onChange: (target: ChosenTarget | null) => void;
  error?: string;
}) {
  const window = useTargetWindow();
  const events = useApiPages({
    path: '/events',
    request: {
      query: {
        facilityId,
        start: window.start,
        end: window.end,
        limit: TARGET_PAGE,
        ...(kind === 'fixture' ? { sourceType: 'fixture' } : {}),
      },
    },
    keyOf: eventKey,
  });
  const options = (events.data ?? [])
    .filter((e) => e.status !== 'canceled')
    .filter((e) =>
      kind === 'fixture'
        ? e.sourceType === 'fixture' && e.sourceId !== null
        : e.sourceType !== 'fixture',
    )
    .map((e) => {
      const when = formatRange(e.scheduledStart, e.scheduledEnd, e.timezone);
      const targetId = kind === 'fixture' ? (e.sourceId as string) : e.id;
      return {
        value: targetId,
        label: `${e.title}, ${when}`,
        target: { targetType: kind, targetId, offeringId: null, title: e.title, when },
      };
    });
  return (
    <ChoiceList
      pages={events}
      label={kind === 'fixture' ? 'Fixture' : 'Event'}
      noun={kind === 'fixture' ? 'fixtures' : 'events'}
      options={options}
      value={value}
      onChange={onChange}
      error={error}
    />
  );
}
