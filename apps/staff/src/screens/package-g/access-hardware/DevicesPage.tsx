/**
 * SCR-S-56 devices of a facility (§3.16 Access hardware "device inventory, outages"; SPK-COND-004):
 * `GET /v1/access-devices?facilityId=` (paged) with each device's observed health and the age of
 * its last heartbeat (an outage is shown with its age; with no heartbeat timeout configured the
 * health is never judged, as the API states it), and registering a device
 * (`POST /v1/access-devices`, entry.register_access_device): a new device is sent deny-all until a
 * policy is approved, and no heartbeat timeout is assumed.
 *
 * Recovery required: the facilities operator's open hardware exceptions at the facility (device
 * offline, a command not delivered, an access outcome unknown) from `GET /v1/exceptions`, each
 * linked to its exception page. Offline, commands are disabled and say so.
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
} from '../../../features/pos-access-accounting/labels';
import { ACCESS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
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

/** Exceptions the API raises for access hardware (entry module, facilities operator queue). */
const HARDWARE_CATEGORIES = new Set([
  'entry.device_offline',
  'entry.device_command_undelivered',
  'entry.access_outcome_unknown',
]);

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
  const exceptions = useApiPages({
    path: '/exceptions',
    request: {
      query: { queue: 'facilities_operator', facilityId, status: 'open', limit: 50 },
    },
  });
  if (exceptions.data === undefined) {
    // Not offered to a viewer who may not read the queue; a failure is shown with its code.
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
      <h4 id="access-exceptions-title">Hardware exceptions waiting for the facilities operator</h4>
      {hardware.length === 0 ? (
        <p className="caption">
          No open hardware exception
          {exceptions.hasNextPage ? ' on the loaded pages of the queue' : ''}.
        </p>
      ) : (
        <ul className="list" aria-label="Open hardware exceptions">
          {hardware.map((e) => (
            <li key={e.id}>
              <div className="row-text">
                <StatusBadge tone="warning" label={`Recovery required: ${e.severity}`} />
                <Link to={`/today/exceptions/${e.id}`}>{e.title}</Link>
                <span className="caption">
                  Open for {e.ageMinutes} minutes. Owner: facilities operator queue.
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
