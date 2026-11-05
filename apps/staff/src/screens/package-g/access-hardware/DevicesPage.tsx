/**
 * SCR-S-56 devices of a facility (§3.16 Access hardware "device inventory, outages"; SPK-COND-004):
 * `GET /v1/access-devices?facilityId=` (paged) with each device's observed health and the age of
 * its last heartbeat (an outage is shown with its age; with no heartbeat timeout configured the
 * health is never judged, as the API states it), and registering a device
 * (`POST /v1/access-devices`, entry.register_access_device): a new device is sent deny-all until a
 * policy is approved, and no heartbeat timeout is assumed.
 *
 * Recovery required (inventory: "events not ingested with owner"): the unresolved hardware
 * exceptions at the facility from `GET /v1/exceptions?facilityId=` (open or acknowledged, every
 * queue the viewer may see): a device offline or a command not delivered (facilities operator
 * queue), events from a device that is not registered here, so not ingested, and an access outcome
 * unknown (the queue the API names, the facility operations queue). Each shows the owner queue the
 * API recorded and links to its exception page; the API cannot filter by category, so the page
 * filters the loaded pages. Event ingestion: the access events the inbox received
 * (`GET /v1/provider-events`, core.view_provider_events), with their status; failed, dead and
 * ignored ones were not ingested. Offline, commands are disabled and say so.
 */
import { formatAge, presentationForError, type Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import {
  FacilityField,
  useFacilityChoice,
  useFacilityDirectory,
  type FacilityDirectory,
} from '../../../features/pos-access-accounting/facilities';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import {
  DEVICE_HEALTH,
  DEVICE_KIND,
  DEVICE_STATUS,
  EXCEPTION_STATUS,
  HARDWARE_EVENT_TYPES,
  HARDWARE_EXCEPTION,
  PROVIDER_EVENT_STATUS,
  queueLabel,
} from '../../../features/pos-access-accounting/labels';
import {
  ACCESS_ACTIONS,
  CORE_ACTIONS,
  useOffer,
} from '../../../features/pos-access-accounting/permission';
import { formatInstant } from '../../../features/registration-finance/format';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { useNow } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { ACCESS_PATHS, DEVICES_QUERY_PREFIX } from './paths';

type Device = Schema<'AccessDevice'>;

const KIND_OPTIONS = (Object.keys(DEVICE_KIND) as Schema<'AccessDeviceKind'>[]).map((k) => ({
  value: k,
  label: DEVICE_KIND[k],
}));

const STATUS_FILTERS = [
  { value: 'active', label: 'Active devices' },
  { value: 'retired', label: 'Retired devices' },
] as const;

/**
 * Exceptions the API raises for access hardware (entry module): device offline, command not
 * delivered and unregistered device go to the facilities operator queue, an access outcome unknown
 * to the facility operations queue; the owner shown is always the one the exception records.
 */
const HARDWARE_CATEGORIES = new Set(Object.keys(HARDWARE_EXCEPTION));

const HARDWARE_EVENT_TYPE = new Map(HARDWARE_EVENT_TYPES.map((t) => [t.value, t.label]));

const EVENT_STATUS_FILTERS = (
  Object.keys(PROVIDER_EVENT_STATUS) as Schema<'ProviderEventStatus'>[]
).map((s) => ({ value: s, label: PROVIDER_EVENT_STATUS[s].label }));

export function DevicesPage() {
  const directory = useFacilityDirectory();
  const { facilityId, setFacilityId } = useFacilityChoice(directory);
  const [status, setStatus] = useState<string>('active');
  return (
    <section aria-labelledby="access-devices-title">
      <h3 id="access-devices-title">Devices</h3>
      <div className="rf-grid">
        <FacilityField
          directory={directory}
          label="Devices at"
          value={facilityId}
          onChange={setFacilityId}
        />
        <SelectField
          label="Show"
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS}
          placeholder="Every device"
        />
      </div>
      {facilityId ? (
        <>
          <DeviceList facilityId={facilityId} status={status} directory={directory} />
          <HardwareExceptions facilityId={facilityId} />
          <EventIngestion zone={directory.timeZoneOf(facilityId)} />
          <RegisterDevice facilityId={facilityId} directory={directory} />
        </>
      ) : (
        <p>Choose a facility to see its access devices.</p>
      )}
    </section>
  );
}

/** "online", or "offline: outage" with how long ago the last heartbeat arrived. */
export function HealthLine({ device, now }: { device: Device; now: Date }) {
  const age = device.lastHeartbeatAt ? formatAge(new Date(device.lastHeartbeatAt), now) : null;
  return (
    <span>
      <StatusBadge {...DEVICE_HEALTH[device.health]} />{' '}
      <span className="caption">
        {age ? `Last heartbeat ${age}.` : 'No heartbeat received.'}
        {device.heartbeatTimeoutSeconds === null
          ? ' Outage detection is off: no heartbeat timeout is set.'
          : ''}
      </span>
    </span>
  );
}

function DeviceList({
  facilityId,
  status,
  directory,
}: {
  facilityId: string;
  status: string;
  directory: FacilityDirectory;
}) {
  const now = useNow();
  const devices = useApiPages({
    path: '/access-devices',
    request: {
      query: {
        facilityId,
        ...(status ? { status: status as Device['status'] } : {}),
        limit: 50,
      },
    },
  });
  return (
    <>
      <QueryBoundary
        query={devices}
        label="access devices"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No devices',
          description: `No access device matches at ${directory.nameOf(facilityId)}.`,
        }}
        unavailableOffline={['registering and changing devices']}
      >
        {(items) => (
          <ul className="list" aria-label="Access devices">
            {items.map((device) => (
              <li key={device.id}>
                <div className="row-text">
                  <Link className="row-title" to={ACCESS_PATHS.device(facilityId, device.id)}>
                    {device.name}
                  </Link>
                  <span>
                    {DEVICE_KIND[device.kind]} · provider reference {device.providerDeviceRef}
                  </span>
                  <StatusBadge {...DEVICE_STATUS[device.status]} />
                  {device.status === 'active' ? <HealthLine device={device} now={now} /> : null}
                  <span className="caption">
                    {device.activePolicyId
                      ? 'An approved policy is in force.'
                      : 'Deny-all: no approved policy.'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={devices} label="devices" />
    </>
  );
}

function HardwareExceptions({ facilityId }: { facilityId: string }) {
  // No queue filter: the owner queue is the API's (the facility operations queue of an unknown
  // access outcome is not the facilities operator's), and rows of queues the viewer may not see
  // are left out by the API. No status filter: open and acknowledged ones are still unresolved.
  const exceptions = useApiPages({
    path: '/exceptions',
    request: { query: { facilityId, limit: 50 } },
  });
  if (exceptions.data === undefined) {
    // Not offered to a viewer who may not read exceptions; a failure is shown with its code.
    if (exceptions.error && presentationForError(exceptions.error) !== 'unavailable') {
      return (
        <StateView
          variant="error"
          error={exceptions.error}
          onRetry={() => void exceptions.refetch()}
        />
      );
    }
    return null;
  }
  const hardware = exceptions.data.filter((e) => HARDWARE_CATEGORIES.has(e.category));
  return (
    <section aria-labelledby="access-exceptions-title" className="rf-panel">
      <h4 id="access-exceptions-title">Hardware exceptions waiting for their owner</h4>
      {hardware.length === 0 ? (
        <p className="caption">
          No unresolved hardware exception
          {exceptions.hasNextPage ? ' on the loaded pages' : ''}.
        </p>
      ) : (
        <ul className="list" aria-label="Unresolved hardware exceptions">
          {hardware.map((e) => (
            <li key={e.id}>
              <div className="row-text">
                <StatusBadge tone="warning" label={`Recovery required: ${e.severity}`} />{' '}
                <StatusBadge {...EXCEPTION_STATUS[e.status]} />
                <Link to={`/today/exceptions/${e.id}`}>{e.title}</Link>
                <span>{HARDWARE_EXCEPTION[e.category] ?? e.category}</span>
                <span className="caption">
                  Open for {e.ageMinutes} minutes. Owner: {queueLabel(e.ownerQueue)}.
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <LoadMore pages={exceptions} label="exceptions" />
    </section>
  );
}

/** What a provider event's inbox status means for ingestion. */
function ingestionText(status: Schema<'ProviderEventStatus'>): string | null {
  switch (status) {
    case 'failed':
      return 'Not ingested yet: the inbox retries it.';
    case 'dead':
      return 'Not ingested: retries are exhausted and the API opened an exception for its owner.';
    case 'ignored':
      return 'Not ingested: the API did not apply it.';
    case 'received':
      return 'Not processed yet.';
    default:
      return null;
  }
}

/**
 * Access events the inbox received (§3.16 "event ingestion", §4.12): the event type, the
 * provider's reference, when it arrived and its status, never the payload (§4.14). The inbox is
 * organization-wide and cannot be filtered by facility or device, so events of every facility are
 * listed; with no event type chosen, the loaded pages are filtered to access hardware events.
 */
function EventIngestion({ zone }: { zone: string | null }) {
  const offer = useOffer();
  const [eventType, setEventType] = useState('');
  const [status, setStatus] = useState('');
  const allowed = offer.allowed(CORE_ACTIONS.viewProviderEvents);
  const events = useApiPages({
    path: '/provider-events',
    request: {
      query: {
        ...(eventType ? { eventType } : {}),
        ...(status ? { status: status as Schema<'ProviderEventStatus'> } : {}),
        limit: 50,
      },
    },
    enabled: allowed,
  });
  if (!allowed) {
    return (
      <p className="caption">
        Reading the events devices send needs the permission {CORE_ACTIONS.viewProviderEvents}.
      </p>
    );
  }
  return (
    <section aria-labelledby="access-events-title" className="rf-panel">
      <h4 id="access-events-title">Event ingestion</h4>
      <p className="caption">
        Events every access device of the organization sent, as the inbox received them; payloads
        are never shown. Failed, dead and ignored events were not ingested.
      </p>
      <div className="rf-grid">
        <SelectField
          label="Event type"
          value={eventType}
          onChange={setEventType}
          options={HARDWARE_EVENT_TYPES}
          placeholder="Every access hardware event"
        />
        <SelectField
          label="Event status"
          value={status}
          onChange={setStatus}
          options={EVENT_STATUS_FILTERS}
          placeholder="Every status"
        />
      </div>
      <QueryBoundary
        query={events}
        label="access events"
        isEmpty={(items) => !items.some((e) => HARDWARE_EVENT_TYPE.has(e.eventType))}
        empty={{
          title: 'No access events',
          description: events.hasNextPage
            ? 'No access hardware event matches on the loaded pages.'
            : 'No access hardware event matches.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Access events received">
            {items
              .filter((e) => HARDWARE_EVENT_TYPE.has(e.eventType))
              .map((e) => {
                const ingestion = ingestionText(e.status);
                return (
                  <li key={e.id}>
                    <div className="row-text">
                      <span className="row-title">
                        {HARDWARE_EVENT_TYPE.get(e.eventType)} ({e.eventType})
                      </span>
                      <StatusBadge {...PROVIDER_EVENT_STATUS[e.status]} />
                      <span className="caption">
                        {e.provider} event {e.providerEventId} received{' '}
                        {formatInstant(e.receivedAt, zone)}
                        {e.signatureVerified ? '' : ' (signature not verified)'} · attempts{' '}
                        {e.attempts}
                      </span>
                      {ingestion ? <span>{ingestion}</span> : null}
                      {e.lastError ? (
                        <span className="caption">Last error: {e.lastError}</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={events} label="events" />
    </section>
  );
}

function RegisterDevice({
  facilityId,
  directory,
}: {
  facilityId: string;
  directory: FacilityDirectory;
}) {
  const offer = useOffer();
  const online = useOnline();
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [timeout, setTimeoutText] = useState('');
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('post', '/access-devices', {
    invalidate: [DEVICES_QUERY_PREFIX],
  });
  const intent = useIntentForm(command);
  if (!offer.capabilityOn('access_hardware')) return null;
  if (!offer.allowed(ACCESS_ACTIONS.registerDevice, facilityId)) {
    return (
      <p className="caption">
        Registering devices needs the permission {ACCESS_ACTIONS.registerDevice}.
      </p>
    );
  }
  const seconds = timeout.trim() ? Number(timeout.trim()) : null;
  const timeoutValid =
    seconds === null || (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!kind || !name.trim() || !ref.trim() || !timeoutValid) return;
    const created = await intent.send({
      body: {
        facilityId,
        kind: kind as Device['kind'],
        name: name.trim(),
        providerDeviceRef: ref.trim(),
        ...(seconds !== null ? { heartbeatTimeoutSeconds: seconds } : {}),
      },
    });
    if (created) {
      setKind('');
      setName('');
      setRef('');
      setTimeoutText('');
      setTouched(false);
    }
  };
  return (
    <form
      className="rf-panel"
      aria-label="Register a device"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Register a device at {directory.nameOf(facilityId)}</h4>
      <p>
        A new device is sent deny-all: it admits nobody until a policy drafted by one person is
        approved by another.
      </p>
      <SelectField
        label="Kind"
        required
        value={kind}
        onChange={setKind}
        options={KIND_OPTIONS}
        placeholder="Choose a kind"
        error={touched && !kind ? 'Choose the kind of device.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Device name"
        required
        value={name}
        onChange={setName}
        error={touched && !name.trim() ? 'Enter a name.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Provider device reference"
        required
        hint="The identifier the hardware provider gives the device (unique in the organization)."
        value={ref}
        onChange={setRef}
        error={touched && !ref.trim() ? 'Enter the provider reference.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Heartbeat timeout in seconds"
        hint="Optional, 1 to 86400. Leave empty and outages are not detected: no timeout is assumed."
        value={timeout}
        onChange={setTimeoutText}
        error={touched && !timeoutValid ? 'Enter whole seconds from 1 to 86400.' : null}
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Register the device
      </Button>
      {command.data && !command.error ? (
        <p role="status">
          {command.data.name} registered and sent deny-all. Draft its access policy next.{' '}
          <Link to={ACCESS_PATHS.device(command.data.facilityId, command.data.id)}>
            Open {command.data.name}
          </Link>
        </p>
      ) : null}
      <OfflineCaption action="registering a device" />
      <CommandError error={command.error} onRetry={intent.retry} />
    </form>
  );
}

/** "Sat, Oct 24, 2026, 04:58 AM PDT" in the facility's zone, or "Never". */
export function heartbeatAt(device: Device, zone: string | null): string {
  return device.lastHeartbeatAt ? formatInstant(device.lastHeartbeatAt, zone) : 'Never';
}
