/**
 * SCR-S-28 Arrival scanner and selection (SPK-ENTRY-001 to SPK-ENTRY-004, SPK-ENTRY-006,
 * SPK-AT-015, §4.15, SPK-AT-018).
 *
 * - Scanning an opaque pass (`POST /v1/passes/scan`) opens a selection of the people and today's
 *   sessions; the scan records nobody (SPK-ENTRY-003). Nothing is preselected: staff tick exactly
 *   the people arriving and the sessions they attend, so a parent arriving with one of two children
 *   records only that child and that session (SPK-AT-015).
 * - Facility arrival (`POST /v1/visits`) and session check-in (`POST /v1/session-checkins`) are
 *   separate records and separate commands, each with its own idempotency key (§4.9); outcomes are
 *   shown per person (partial completion is permitted per person).
 * - Check-in issues are shown as the API states them (severity as text, message, next action); an
 *   unrelated balance blocks only when the API says it is blocking (SPK-ENTRY-004, DEC-056).
 * - Offline, arrivals for the scanned people are queued against that scan as the roster snapshot
 *   and synchronised once on reconnection (§4.15); check-in, payments, capacity, guardian changes,
 *   roster transfers and pickup permission need a connection.
 * - Visitor categories are the API's; which ones a facility uses is DEC-071 (pending).
 * - Looking a person up without a pass is not available: the API has no person search.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { activityFromDetail, activitySearch } from '../../features/operations/activity';
import { ARRIVAL_TABS, AreaTabs } from '../../features/operations/AreaTabs';
import { useKeyedCommands } from '../../features/operations/commands';
import { useOperatingFacility } from '../../features/operations/context';
import { ChooseFacility, CommandError, CommandSuccess } from '../../features/operations/feedback';
import { CheckboxField, SelectField, TextField } from '../../features/operations/fields';
import { formatRange, humanize } from '../../features/operations/format';
import {
  CHECKIN_STATUS,
  ISSUE_SEVERITY,
  VISITOR_CATEGORY_LABEL,
} from '../../features/operations/labels';
import { useOfflineQueue } from '../../features/operations/offline/OfflineQueueProvider';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import type { RosterSnapshot } from '../../features/operations/offline/queue';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type PassScan = Schema<'PassScan'>;
type ScanPerson = Schema<'ScanPerson'>;
type ScanActivity = Schema<'ScanActivity'>;
type SessionCheckin = Schema<'SessionCheckin'>;
type RecordedVisits = Schema<'RecordedVisits'>;
type Category = keyof typeof VISITOR_CATEGORY_LABEL;

const CATEGORY_OPTIONS = (Object.keys(VISITOR_CATEGORY_LABEL) as Category[]).map((value) => ({
  value,
  label: VISITOR_CATEGORY_LABEL[value],
}));

const RELATION_LABEL: Record<ScanPerson['relation'], string> = {
  holder: 'Pass holder',
  household_member: 'Household member',
  dependent: 'Dependent',
};

function passErrorMessage(error: ApiError): string | null {
  if (error.isNotFound) return 'Pass not recognised. Check the reference or scan it again.';
  const details = error.details as { code?: unknown } | undefined;
  if (error.code === 'RESOURCE_CONFLICT' && details?.code === 'pass_revoked') {
    return 'This pass has been revoked. Ask the holder for their current pass.';
  }
  return null;
}

export function ArrivalScannerScreen() {
  const facility = useOperatingFacility();
  const { online } = useApp();
  const queue = useOfflineQueue();
  const [reference, setReference] = useState('');
  const [scan, setScan] = useState<{ result: PassScan; snapshot: RosterSnapshot; at: Date } | null>(
    null,
  );
  const scanCommand = useApiCommand('post', '/passes/scan');
  const occupancy = useApiQuery({
    path: '/facilities/{id}/occupancy',
    request: { path: { id: facility.facilityId ?? '' } },
    enabled: facility.facilityId !== null,
  });
  const now = useNow();

  const openSelection = () => {
    if (!facility.facilityId || reference.trim().length === 0) return;
    void scanCommand
      .submit({ body: { reference: reference.trim(), facilityId: facility.facilityId } })
      .then((result) => {
        setScan({ result, snapshot: queue.newSnapshot(result.scannedAt), at: now });
        setReference('');
      })
      .catch(() => undefined);
  };

  const scanError = scanCommand.error;
  const passMessage = scanError ? passErrorMessage(scanError) : null;

  return (
    <section aria-labelledby="arrival-title">
      <h2 id="arrival-title">Arrival scanner</h2>
      <AreaTabs label="Arrival and attendance screens" tabs={ARRIVAL_TABS} />
      <OfflineQueueStatus />
      {!facility.facilityId ? (
        facility.loading ? (
          <StateView variant="loading" label="your facilities" />
        ) : (
          <ChooseFacility purpose="scan passes and record arrivals" />
        )
      ) : (
        <>
          {occupancy.data ? (
            <p className="caption" data-testid="occupancy">
              Arrivals recorded today: {occupancy.data.arrivals.people}; departures:{' '}
              {occupancy.data.departures.people}; recorded on site: {occupancy.data.recordedOnSite}.{' '}
              {occupancy.data.occupancy.status === 'verified'
                ? `Verified occupancy: ${occupancy.data.occupancy.verifiedOccupancy ?? 0}.`
                : 'Not verified occupancy.'}{' '}
              {occupancy.data.occupancy.statement}
            </p>
          ) : null}
          <div className="ops-section">
            <h3>Scan a pass</h3>
            <form
              className="ops-form"
              onSubmit={(event) => {
                event.preventDefault();
                openSelection();
              }}
            >
              <TextField
                label="Pass reference"
                value={reference}
                onChange={(value) => {
                  setReference(value);
                  if (scanCommand.error) scanCommand.reset();
                }}
                hint="Scan with a connected reader or type the reference. Nothing is recorded until you choose who is arriving."
                error={passMessage ?? undefined}
                disabled={!online}
              />
              <div className="ops-actions">
                <Button
                  type="submit"
                  busy={scanCommand.isProcessing}
                  disabled={!online || reference.trim().length === 0}
                >
                  Open selection
                </Button>
              </div>
            </form>
            {!online ? (
              <p className="caption">
                Scanning needs a connection. A pass scanned before the connection was lost stays
                open below; arrivals for it are queued on this device.
              </p>
            ) : null}
            {scanError && !passMessage ? (
              <CommandError error={scanError} onRetry={openSelection} subject="This pass" />
            ) : null}
            {scanError && passMessage ? (
              <p className="caption">Error code: {scanError.code}</p>
            ) : null}
          </div>
          <div className="ops-section">
            <h3>Find a person without a pass</h3>
            <StateView
              variant="unavailable"
              title="Not available yet"
              description="Looking a person up is not available here: the service does not offer a person search yet. Scan the person's pass or the household pass."
            />
          </div>
          {scan ? (
            <ArrivalSelection
              key={scan.result.pass.id + scan.result.scannedAt}
              scan={scan.result}
              snapshot={scan.snapshot}
              receivedAt={scan.at}
              facilityId={facility.facilityId}
              timezone={facility.timezone}
              onDone={() => setScan(null)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

interface SelectionProps {
  scan: PassScan;
  snapshot: RosterSnapshot;
  receivedAt: Date;
  facilityId: string;
  timezone: string | null;
  onDone: () => void;
}

const checkinKey = (personId: string, activity: ScanActivity) =>
  `checkin|${personId}|${activity.activity.id}`;

function ArrivalSelection({
  scan,
  snapshot,
  receivedAt,
  facilityId,
  timezone,
  onDone,
}: SelectionProps) {
  const { online, services } = useApp();
  const queue = useOfflineQueue();
  const now = useNow();
  const [arriving, setArriving] = useState<Record<string, boolean>>({});
  const [categories, setCategories] = useState<Record<string, Category | ''>>({});
  const [checkins, setCheckins] = useState<Record<string, boolean>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [queued, setQueued] = useState<number | null>(null);
  const commands = useKeyedCommands({ invalidate: [['api', '/facilities/{id}/occupancy']] });
  const [visitIds, setVisitIds] = useState<Record<string, string>>({});

  const maxAge = services.config.offlineRosterMaxAgeMs ?? null;
  const rosterAgeMs = now.getTime() - new Date(snapshot.takenAt).getTime();
  const rosterTooOld = maxAge !== null && rosterAgeMs > maxAge;

  const categoryOf = (person: ScanPerson): Category | '' =>
    categories[person.personId] ?? (person.activities.length > 0 ? 'participant' : '');

  // Already recorded in this selection: never sent again (a retry resends only what is missing).
  const selectedArrivals = scan.people.filter(
    (p) => arriving[p.personId] && !p.onSite && visitIds[p.personId] === undefined,
  );
  const selectedCheckins = scan.people.flatMap((p) =>
    p.activities
      .filter(
        (a) =>
          checkins[checkinKey(p.personId, a)] &&
          !a.checkin &&
          commands.outcome(checkinKey(p.personId, a)).status !== 'success',
      )
      .map((a) => ({ person: p, activity: a })),
  );
  const nothingSelected = selectedArrivals.length === 0 && selectedCheckins.length === 0;

  const submit = async () => {
    const unset = selectedArrivals.filter((p) => categoryOf(p) === '').map((p) => p.personId);
    setMissing(unset);
    if (unset.length > 0) return;

    if (!online) {
      if (rosterTooOld) return;
      queue.enqueue(
        selectedArrivals.map((p) => ({
          item: {
            kind: 'arrival' as const,
            clientObservationId: queue.newObservationId(),
            observedAt: services.now().toISOString(),
            personId: p.personId,
            visitorCategory: categoryOf(p) as Category,
          },
          facilityId,
          snapshot,
          context: 'Facility arrival',
        })),
      );
      setQueued(selectedArrivals.length);
      setArriving({});
      return;
    }

    let visits: Record<string, string> = { ...visitIds };
    if (selectedArrivals.length > 0) {
      const recorded = (await commands.run('visits', 'post', '/visits', {
        body: {
          facilityId,
          passId: scan.pass.id,
          arrivals: selectedArrivals.map((p) => ({
            personId: p.personId,
            visitorCategory: categoryOf(p) as Category,
          })),
        },
      })) as RecordedVisits | undefined;
      if (!recorded) return;
      for (const v of recorded.visits) if (v.personId) visits[v.personId] = v.id;
      visits = { ...visits };
      setVisitIds(visits);
    }
    for (const { person, activity } of selectedCheckins) {
      const ref = activityFromDetail(activity.activity);
      if (!ref) continue;
      const visitId = visits[person.personId] ?? person.visitId ?? undefined;
      await commands.run(checkinKey(person.personId, activity), 'post', '/session-checkins', {
        body: { personId: person.personId, activity: ref, ...(visitId ? { visitId } : {}) },
      });
    }
  };

  const visitsOutcome = commands.outcome('visits');

  return (
    <section className="ops-section" aria-labelledby="selection-title">
      <h3 id="selection-title">Who is arriving?</h3>
      <p>
        Tick only the people arriving now and the sessions they attend. Nobody is marked present by
        the scan.
      </p>
      <LastUpdated at={receivedAt} now={now} prefix="Scanned" />
      {!online ? (
        <StateView
          variant="offline-stale"
          offline
          updatedAt={receivedAt}
          now={now}
          unavailableActions={[
            'session check-in',
            'payments',
            'capacity',
            'guardian changes',
            'roster transfers',
            'pickup permission',
          ]}
        />
      ) : null}
      {!online && rosterTooOld ? (
        <StateView
          variant="unavailable"
          title="Roster too old to queue against"
          description="This scan is older than the configured maximum roster age. Reconnect and scan the pass again."
        />
      ) : null}
      {!online && maxAge === null ? (
        <StateView
          variant="pending-decision"
          subject="A maximum roster age for offline queuing"
          decisions={['DEC-033']}
          owner="Operations"
        />
      ) : null}
      {scan.people.length === 0 ? (
        <StateView
          variant="empty"
          title="Nobody to select"
          description="This pass resolves to nobody with an active record at this facility today."
        />
      ) : (
        <ul className="ops-cards" aria-label="People on this pass">
          {scan.people.map((person) => (
            <PersonSelection
              key={person.personId}
              person={person}
              timezone={timezone}
              online={online}
              arriving={!!arriving[person.personId]}
              onArriving={(value) => setArriving((prev) => ({ ...prev, [person.personId]: value }))}
              category={categoryOf(person)}
              onCategory={(value) =>
                setCategories((prev) => ({ ...prev, [person.personId]: value as Category | '' }))
              }
              categoryMissing={missing.includes(person.personId)}
              checkinSelected={(a) => !!checkins[checkinKey(person.personId, a)]}
              onCheckin={(a, value) =>
                setCheckins((prev) => ({ ...prev, [checkinKey(person.personId, a)]: value }))
              }
              commands={commands}
              arrivalRecorded={
                visitsOutcome.status === 'success' && visitIds[person.personId] !== undefined
              }
            />
          ))}
        </ul>
      )}
      {visitsOutcome.status === 'error' && visitsOutcome.error ? (
        <CommandError error={visitsOutcome.error} onRetry={() => void submit()} />
      ) : null}
      {queued !== null ? (
        <CommandSuccess
          tone="warning"
          label={`${queued} arrival${queued === 1 ? '' : 's'} queued on this device: not yet recorded`}
        >
          <span className="caption">They synchronise once when the connection returns.</span>
        </CommandSuccess>
      ) : null}
      <div className="ops-actions">
        <Button
          onClick={() => void submit()}
          busy={commands.anyPending}
          disabled={nothingSelected || (!online && (rosterTooOld || selectedArrivals.length === 0))}
        >
          {online ? 'Record selected' : 'Queue selected arrivals'}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Scan next
        </Button>
      </div>
    </section>
  );
}

function PersonSelection({
  person,
  timezone,
  online,
  arriving,
  onArriving,
  category,
  onCategory,
  categoryMissing,
  checkinSelected,
  onCheckin,
  commands,
  arrivalRecorded,
}: {
  person: ScanPerson;
  timezone: string | null;
  online: boolean;
  arriving: boolean;
  onArriving: (value: boolean) => void;
  category: Category | '';
  onCategory: (value: string) => void;
  categoryMissing: boolean;
  checkinSelected: (a: ScanActivity) => boolean;
  onCheckin: (a: ScanActivity, value: boolean) => void;
  commands: ReturnType<typeof useKeyedCommands>;
  arrivalRecorded: boolean;
}) {
  const name = `${person.givenName} ${person.familyName}`.trim();
  const onSite = person.onSite || arrivalRecorded;
  return (
    <li aria-label={name}>
      <div className="ops-row">
        <span className="row-title">{name}</span>
        <span className="caption">
          {person.kind === 'child' ? 'Child' : 'Adult'} · {RELATION_LABEL[person.relation]}
        </span>
      </div>
      {onSite ? (
        <StatusBadge tone="success" label="Arrived" />
      ) : (
        <>
          <CheckboxField
            label={`Record arrival at the facility for ${name}`}
            checked={arriving}
            onChange={onArriving}
          />
          {arriving ? (
            <SelectField
              label={`Visitor category for ${name}`}
              value={category}
              onChange={onCategory}
              options={CATEGORY_OPTIONS}
              placeholder="Choose a category"
              hint="Which categories this facility uses is pending (DEC-071)."
              error={categoryMissing ? 'Choose a visitor category.' : undefined}
            />
          ) : null}
        </>
      )}
      {person.activities.length === 0 ? (
        <p className="caption">No session today for {name}.</p>
      ) : (
        <ul className="ops-history" aria-label={`Sessions today for ${name}`}>
          {person.activities.map((activity) => (
            <ActivityCheckin
              key={activity.activity.id}
              person={person}
              name={name}
              activity={activity}
              timezone={timezone}
              online={online}
              selected={checkinSelected(activity)}
              onSelected={(value) => onCheckin(activity, value)}
              commands={commands}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function ActivityCheckin({
  person,
  name,
  activity,
  timezone,
  online,
  selected,
  onSelected,
  commands,
}: {
  person: ScanPerson;
  name: string;
  activity: ScanActivity;
  timezone: string | null;
  online: boolean;
  selected: boolean;
  onSelected: (value: boolean) => void;
  commands: ReturnType<typeof useKeyedCommands>;
}) {
  const key = checkinKey(person.personId, activity);
  const outcome = commands.outcome(key);
  const recheckKey = `recheck|${key}`;
  const recheck = commands.outcome(recheckKey);
  const fromCommand = (recheck.data ?? outcome.data) as SessionCheckin | undefined;
  const when = formatRange(activity.scheduledStart, activity.scheduledEnd, timezone);
  const ref = activityFromDetail(activity.activity);
  const attendanceLink = ref ? `/arrival/attendance${activitySearch(ref)}` : null;

  if (activity.checkin && !fromCommand) {
    const badge = CHECKIN_STATUS[activity.checkin.status];
    return (
      <li>
        <StatusBadge
          tone={badge.tone}
          label={
            activity.checkin.status === 'admitted'
              ? `Checked in to ${activity.title}`
              : `${badge.label}: ${activity.title}`
          }
        />{' '}
        <span className="caption">{when}</span>
      </li>
    );
  }
  if (fromCommand) {
    return (
      <li>
        <CheckinOutcome
          checkin={fromCommand}
          title={activity.title}
          busy={recheck.status === 'pending'}
          onRecheck={() =>
            void commands.run(recheckKey, 'post', '/session-checkins/{id}/recheck', {
              path: { id: fromCommand.id },
              body: { expectedRevision: fromCommand.revision },
            })
          }
        />
        {recheck.status === 'error' && recheck.error ? (
          <CommandError error={recheck.error} subject="This check-in" />
        ) : null}
      </li>
    );
  }
  return (
    <li>
      <CheckboxField
        label={`Check ${name} in to ${activity.title}`}
        hint={`${when} · ${humanize(activity.basis.kind)} ${humanize(activity.basis.status).toLowerCase()}${online ? '' : ' · Check-in needs a connection'}`}
        checked={selected}
        disabled={!online}
        onChange={onSelected}
      />
      {attendanceLink ? (
        <Link to={attendanceLink} className="caption">
          Session attendance for {activity.title}
        </Link>
      ) : null}
      {outcome.status === 'error' && outcome.error ? (
        <CommandError error={outcome.error} subject="This check-in" />
      ) : null}
    </li>
  );
}

export function CheckinOutcome({
  checkin,
  title,
  onRecheck,
  busy,
}: {
  checkin: SessionCheckin;
  title: string;
  onRecheck?: () => void;
  busy?: boolean;
}) {
  const badge = CHECKIN_STATUS[checkin.status];
  const issues = useMemo(() => checkin.issues, [checkin.issues]);
  return (
    <div className="ops-section" data-testid="checkin-outcome">
      <StatusBadge
        tone={badge.tone}
        label={
          checkin.status === 'admitted' ? `Checked in to ${title}` : `${badge.label}: ${title}`
        }
      />
      {issues.length > 0 ? (
        <ul className="ops-history" aria-label={`Arrival checks for ${title}`}>
          {issues.map((issue) => {
            const severity = ISSUE_SEVERITY[issue.severity];
            return (
              <li key={`${issue.code}-${issue.reference?.id ?? ''}`}>
                <StatusBadge tone={severity.tone} label={severity.label} /> {issue.message}{' '}
                <span className="caption">Next: {humanize(issue.nextAction)}.</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {checkin.status === 'held' && onRecheck ? (
        <div className="ops-actions">
          <Button variant="secondary" busy={busy} onClick={onRecheck}>
            Check again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
