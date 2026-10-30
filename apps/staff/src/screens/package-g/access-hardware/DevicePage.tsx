/**
 * SCR-S-56 one access device (§3.16 Access hardware "device inventory, access policy, revocation,
 * outages, audit"; SPK-COND-004, SPK-ENTRY-002):
 *
 * - the device as listed by `GET /v1/access-devices?facilityId=` (the API has no single-device
 *   read; a device not in the facility's list is "not available"), with health and outage age;
 * - renaming it or setting its heartbeat timeout with the revision it was read at
 *   (`PATCH /v1/access-devices/{id}`, entry.update_access_device), and retiring it with a reason
 *   (`POST /v1/access-devices/{id}/retire`, never gated);
 * - its policies (`GET /v1/access-devices/{id}/policies`): a draft is written by one person
 *   (`POST /v1/access-devices/{id}/policies`) and approved by another
 *   (`POST /v1/access-policies/{id}/approve`; its author is told another person approves it), which
 *   retires the previous one and synchronizes the device; retiring or withdrawing a policy
 *   (`POST /v1/access-policies/{id}/retire`, never gated) sends deny-all without a replacement.
 *   Schedule times are the facility's local time (SPK-SCHED-008);
 * - its command queue with delivery outcomes (`GET /v1/access-devices/{id}/commands`, paged):
 *   failed and unknown deliveries are retried by the API's job, never resent from here.
 */
import { formatAge, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { CommandError } from '../../../features/pos-access-accounting/CommandError';
import { useFacilityDirectory } from '../../../features/pos-access-accounting/facilities';
import { LinkNotAvailable } from '../../../features/pos-access-accounting/fields';
import { useIntentForm } from '../../../features/pos-access-accounting/intent';
import {
  COMMAND_KIND,
  COMMAND_STATUS,
  DEVICE_KIND,
  DEVICE_STATUS,
} from '../../../features/pos-access-accounting/labels';
import { ACCESS_ACTIONS, useOffer } from '../../../features/pos-access-accounting/permission';
import { ReasonAction } from '../../../features/pos-access-accounting/ReasonAction';
import { formatInstant, shortRef } from '../../../features/registration-finance/format';
import { OfflineCaption, useOnline } from '../../../features/registration-finance/offline';
import { useNow } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { Facts, SelectField, TextField } from '../../../ui/FormFields';
import { LoadMore } from '../../../ui/LoadMore';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { isUuid } from '../../../ui/RecordRef';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { HealthLine, heartbeatAt } from './DevicesPage';
import { DEVICES_QUERY_PREFIX } from './paths';
import { Policies } from './Policies';

type Device = Schema<'AccessDevice'>;

export function DevicePage() {
  const { facilityId = '', deviceId = '' } = useParams();
  if (!isUuid(facilityId) || !isUuid(deviceId)) return <LinkNotAvailable />;
  return <DeviceView facilityId={facilityId} deviceId={deviceId} />;
}

function DeviceView({ facilityId, deviceId }: { facilityId: string; deviceId: string }) {
  const devices = useApiPages({
    path: '/access-devices',
    request: { query: { facilityId, limit: 100 } },
  });
  const device = devices.data?.find((d) => d.id === deviceId);
  return (
    <section aria-labelledby="access-device-title">
      <h3 id="access-device-title">{device ? device.name : `Device ${shortRef(deviceId)}`}</h3>
      <QueryBoundary
        query={devices}
        label="the device"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the device', 'policies']}
      >
        {() =>
          device ? (
            <DeviceBody device={device} />
          ) : devices.hasNextPage ? (
            <p>The device is not among the devices loaded so far.</p>
          ) : (
            <StateView variant="unavailable" />
          )
        }
      </QueryBoundary>
      {!device ? <LoadMore pages={devices} label="devices" /> : null}
    </section>
  );
}

function DeviceBody({ device }: { device: Device }) {
  const directory = useFacilityDirectory();
  const offer = useOffer();
  const now = useNow();
  const zone = directory.timeZoneOf(device.facilityId);
  const active = device.status === 'active';
  return (
    <>
      <p>
        <StatusBadge {...DEVICE_STATUS[device.status]} />{' '}
        {active ? <HealthLine device={device} now={now} /> : null}
      </p>
      {active && device.health === 'offline' ? (
        <section className="state" aria-live="polite" data-testid="state-device-outage">
          <StatusBadge tone="danger" label="Device outage" />
          <p>
            No heartbeat for longer than its timeout: the last one was{' '}
            {device.lastHeartbeatAt ? formatAge(new Date(device.lastHeartbeatAt), now) : 'never'} (
            {heartbeatAt(device, zone)}). Commands wait and are retried; the facilities operator
            owns the outage.
          </p>
        </section>
      ) : null}
      <Facts
        label="Access device"
        items={[
          ['Facility', directory.nameOf(device.facilityId)],
          ['Kind', DEVICE_KIND[device.kind]],
          ['Provider device reference', device.providerDeviceRef],
          ['Last heartbeat', heartbeatAt(device, zone)],
          [
            'Heartbeat timeout',
            device.heartbeatTimeoutSeconds === null
              ? 'Not set: outages are not detected'
              : `${device.heartbeatTimeoutSeconds} seconds`,
          ],
          [
            'Access policy',
            device.activePolicyId
              ? `Policy ${shortRef(device.activePolicyId)} in force`
              : 'Deny-all: no approved policy',
          ],
          [
            'Registered',
            `${formatInstant(device.registeredAt, zone)} by ${device.registeredBy.actorLabel}`,
          ],
          ...(device.retiredAt
            ? ([
                ['Retired', formatInstant(device.retiredAt, zone)],
                ['Retire reason', device.retiredReason ?? 'Not stated'],
              ] as [string, string][])
            : []),
        ]}
      />
      {active &&
      offer.capabilityOn('access_hardware') &&
      offer.allowed(ACCESS_ACTIONS.updateDevice, device.facilityId) ? (
        <EditDevice device={device} />
      ) : null}
      {active && offer.allowed(ACCESS_ACTIONS.retireDevice, device.facilityId) ? (
        <RetireDevice device={device} />
      ) : null}
      <Policies device={device} zone={zone} />
      <Commands device={device} zone={zone} />
    </>
  );
}

function EditDevice({ device }: { device: Device }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [name, setName] = useState(device.name);
  const [timeout, setTimeoutText] = useState(
    device.heartbeatTimeoutSeconds === null ? '' : String(device.heartbeatTimeoutSeconds),
  );
  const [touched, setTouched] = useState(false);
  const command = useApiCommand('patch', '/access-devices/{id}', {
    invalidate: [DEVICES_QUERY_PREFIX],
  });
  const intent = useIntentForm(command);
  const seconds = timeout.trim() ? Number(timeout.trim()) : null;
  const timeoutValid =
    seconds === null || (Number.isInteger(seconds) && seconds >= 1 && seconds <= 86_400);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!name.trim() || !timeoutValid) return;
    const changes = {
      ...(name.trim() !== device.name ? { name: name.trim() } : {}),
      ...(seconds !== device.heartbeatTimeoutSeconds ? { heartbeatTimeoutSeconds: seconds } : {}),
    };
    if (Object.keys(changes).length === 0) return;
    await intent.send({
      path: { id: device.id },
      body: { ...changes, expectedRevision: device.revision },
    });
  };
  return (
    <form
      className="rf-panel"
      aria-label="Change the device"
      onSubmit={(e) => void submit(e)}
      noValidate
    >
      <h4>Change the device</h4>
      <TextField
        label="Device name"
        required
        value={name}
        onChange={setName}
        error={touched && !name.trim() ? 'Enter a name.' : null}
        disabled={intent.locked}
      />
      <TextField
        label="Heartbeat timeout in seconds"
        hint="1 to 86400. Empty clears it: outages are then not detected."
        value={timeout}
        onChange={setTimeoutText}
        error={touched && !timeoutValid ? 'Enter whole seconds from 1 to 86400.' : null}
        disabled={intent.locked}
      />
      <Button type="submit" busy={command.isProcessing} disabled={!online || intent.locked}>
        Save the device
      </Button>
      {command.data && !command.error ? <p role="status">Device saved.</p> : null}
      <OfflineCaption action="changing the device" />
      <CommandError
        error={command.error}
        onRetry={intent.retry}
        onReload={() => {
          intent.restart();
          void queryClient.invalidateQueries({ queryKey: DEVICES_QUERY_PREFIX });
        }}
      />
    </form>
  );
}

function RetireDevice({ device }: { device: Device }) {
  const online = useOnline();
  const command = useApiCommand('post', '/access-devices/{id}/retire', {
    invalidate: [DEVICES_QUERY_PREFIX],
  });
  return (
    <div>
      <ReasonAction
        label="Retire the device"
        confirmLabel="Retire the device"
        reasonLabel="Reason for retiring"
        explanation="A retired device is sent no further command and keeps its provider reference; its history stays."
        busy={command.isProcessing}
        disabled={!online}
        onConfirm={async (reason) => {
          try {
            await command.submit({
              path: { id: device.id },
              body: { reason, expectedRevision: device.revision },
            });
            return true;
          } catch {
            return false;
          }
        }}
      />
      <CommandError error={command.error} />
    </div>
  );
}

const COMMAND_FILTERS = (Object.keys(COMMAND_STATUS) as Schema<'DeviceCommandStatus'>[]).map(
  (s) => ({ value: s, label: COMMAND_STATUS[s].label }),
);

function Commands({ device, zone }: { device: Device; zone: string | null }) {
  const [status, setStatus] = useState('');
  const commands = useApiPages({
    path: '/access-devices/{id}/commands',
    request: {
      path: { id: device.id },
      query: { ...(status ? { status: status as Schema<'DeviceCommandStatus'> } : {}), limit: 50 },
    },
  });
  return (
    <section aria-labelledby="access-commands-title">
      <h4 id="access-commands-title">Command queue</h4>
      <p className="caption">
        The API delivers policy synchronizations and credential revocations outside any transaction.
        Failed and unknown deliveries are retried by the API; an unknown one is asked again and
        never sent twice from here.
      </p>
      <SelectField
        label="Show commands"
        value={status}
        onChange={setStatus}
        options={COMMAND_FILTERS}
        placeholder="Every command"
      />
      <QueryBoundary
        query={commands}
        label="device commands"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No commands', description: 'No command matches for this device.' }}
      >
        {(items) => (
          <div className="rf-table-wrap">
            <table className="rf-table" aria-label="Device commands">
              <thead>
                <tr>
                  <th scope="col">Queued</th>
                  <th scope="col">Command</th>
                  <th scope="col">Delivery</th>
                  <th scope="col">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>{formatInstant(c.createdAt, zone)}</td>
                    <td>
                      {COMMAND_KIND[c.kind]}
                      <span className="caption">
                        {c.kind === 'sync_policy'
                          ? c.policyId
                            ? ` (policy ${shortRef(c.policyId)})`
                            : ' (deny-all)'
                          : ''}
                      </span>
                    </td>
                    <td>
                      <StatusBadge {...COMMAND_STATUS[c.status]} />
                      {c.deliveredAt ? (
                        <span className="caption"> {formatInstant(c.deliveredAt, zone)}</span>
                      ) : null}
                      {c.lastError ? <span className="caption"> {c.lastError}</span> : null}
                    </td>
                    <td>
                      {c.attempts}
                      {c.lastAttemptAt ? (
                        <span className="caption">
                          {' '}
                          last {formatInstant(c.lastAttemptAt, zone)}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryBoundary>
      <LoadMore pages={commands} label="commands" />
    </section>
  );
}
