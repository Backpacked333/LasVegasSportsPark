/**
 * SCR-C-36 push on this device and the devices registered for push (SPK-UX-001 "Push notification
 * registration and preferences", SPK-COMMS-003, SPK-COMMS-007, SPK-IAM-006; DEC-061, DEC-020).
 *
 * - This device: the operating system's permission (push-permission reader). When it is denied
 *   the screen explains it and that in-app notices continue. Registering this install
 *   (`POST /v1/me/push-devices` with the platform, the platform push token and the app version)
 *   needs a push module and its permission explanation, which wait on DEC-061 and the messaging
 *   provider DEC-020: this build has neither, so registration is shown as pending. A build whose
 *   reader supplies a token offers "Register this device"; re-registering the same token only
 *   refreshes it (the API keeps one registration per token).
 * - Devices registered: `GET /v1/me/push-devices` (token hints only, never a token) with platform,
 *   app version, dates and state; "Stop push to this device" revokes one
 *   (`POST /v1/me/push-devices/{id}/revoke` with a reason and its revision; the API erases the
 *   token and sends nothing more). Revoking needs no push module, so it works in this build.
 *
 * Essential notices always appear in the in-app inbox whatever happens to push (SPK-COMMS-007).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { formatDateTime } from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { Paragraph, SectionHeader, TextField } from '../account/components/forms';
import { usePushPermissionReader, usePushPermissionStatus } from './push-permission';

type PushDevice = Schema<'PushDevice'>;

export const PUSH_DEVICES_KEY = ['api', '/me/push-devices'] as const;

const PLATFORM_LABELS: Record<PushDevice['platform'], string> = {
  ios: 'iPhone or iPad',
  android: 'Android device',
  web: 'Web browser',
};

export function deviceTitle(device: PushDevice): string {
  return `${PLATFORM_LABELS[device.platform]} ending ${device.tokenHint}`;
}

export function deviceDetail(device: PushDevice): string {
  const parts = [
    device.appVersion ? `App version ${device.appVersion}` : null,
    `Registered ${formatDateTime(device.registeredAt)}`,
    device.status === 'active'
      ? `Last seen ${formatDateTime(device.lastSeenAt)}`
      : device.revokedAt
        ? `Stopped ${formatDateTime(device.revokedAt)}`
        : null,
  ];
  return parts.filter(Boolean).join('. ');
}

export function PushDevicesSection() {
  const [registeredId, setRegisteredId] = useState<string | null>(null);
  return (
    <View>
      <SectionHeader title="Push on this device" />
      <ThisDevice onRegistered={setRegisteredId} />
      <SectionHeader
        title="Devices registered for push"
        detail="Push notices go to every device listed as receiving push."
      />
      <RegisteredDevices thisDeviceId={registeredId} />
    </View>
  );
}

function ThisDevice({ onRegistered }: { onRegistered: (id: string) => void }) {
  const status = usePushPermissionStatus();
  const reader = usePushPermissionReader();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    if (status !== 'granted' || !reader.deviceToken) {
      setToken(null);
      return;
    }
    reader
      .deviceToken()
      .then((t) => {
        if (active) setToken(t);
      })
      .catch(() => {
        if (active) setToken(null);
      });
    return () => {
      active = false;
    };
  }, [reader, status]);

  if (status === null || (status === 'granted' && reader.deviceToken && token === undefined)) {
    return <StateView variant="loading" label="push settings" />;
  }
  if (status === 'denied') {
    return (
      <StateView
        variant="unavailable"
        title="Push is turned off for this app"
        description="Your device settings block notifications from this app. Essential notices still appear in the app's inbox. To get push, allow notifications for this app in your device settings."
      />
    );
  }
  if (status === 'granted' && token) {
    return <RegisterThisDevice token={token} onRegistered={onRegistered} />;
  }
  return (
    <View>
      {status === 'unavailable' ? (
        <StateView
          variant="unavailable"
          title="Push is not set up in this version"
          description="This version of the app does not register for push notifications. Essential notices always appear in the app's inbox."
        />
      ) : null}
      <StateView
        variant="pending-decision"
        subject="Registering this device for push notifications"
        decisions={['DEC-061', 'DEC-020']}
        owner="Technical lead/operator (DEC-061); Technical lead/account owners (DEC-020)"
      />
    </View>
  );
}

function RegisterThisDevice({
  token,
  onRegistered,
}: {
  token: string;
  onRegistered: (id: string) => void;
}) {
  const { services } = useApp();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const register = useApiCommand('post', '/me/push-devices', { invalidate: [PUSH_DEVICES_KEY] });
  const submit = async () => {
    try {
      const device = await register.submit({
        body: {
          platform: services.config.platform,
          token,
          appVersion: services.config.appVersion,
        },
      });
      onRegistered(device.id);
    } catch {
      // register.error is rendered below.
    }
  };
  return (
    <View style={styles.box}>
      {register.data ? (
        <StatusBadge tone="success" label="This device receives push" />
      ) : (
        <Paragraph inset={false}>
          Notifications are allowed for this app. Register this device to get push notices too.
        </Paragraph>
      )}
      <Button
        label={register.data ? 'Register again' : 'Register this device'}
        variant={register.data ? 'secondary' : 'primary'}
        onPress={() => void submit()}
        busy={register.isProcessing}
        disabled={offline}
        accessibilityHint={offline ? 'Needs a connection' : undefined}
      />
      {offline ? (
        <Paragraph muted inset={false}>
          Registering needs a connection.
        </Paragraph>
      ) : null}
      {register.error ? (
        <CommandError error={register.error} onRetry={() => void submit()} />
      ) : null}
    </View>
  );
}

function RegisteredDevices({ thisDeviceId }: { thisDeviceId: string | null }) {
  const devices = useApiQuery({ path: '/me/push-devices' });
  return (
    <QueryBoundary
      query={devices}
      label="devices registered for push"
      isEmpty={(data) => data.devices.length === 0}
      empty={{
        title: 'No devices registered',
        description:
          'No device receives push notices for your account. Essential notices always appear in the app.',
      }}
      unavailableOffline={['stopping push to a device']}
    >
      {(data) => (
        <View accessibilityRole="list" accessibilityLabel="Devices registered for push">
          {[...data.devices]
            .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))
            .map((device) => (
              <DeviceRow key={device.id} device={device} thisDevice={device.id === thisDeviceId} />
            ))}
        </View>
      )}
    </QueryBoundary>
  );
}

function DeviceRow({ device, thisDevice }: { device: PushDevice; thisDevice: boolean }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const revoke = useApiCommand('post', '/me/push-devices/{id}/revoke', {
    invalidate: [PUSH_DEVICES_KEY],
  });
  const sent = useRef<{ reason: string; expectedRevision: number } | null>(null);
  const active = device.status === 'active';
  const title = `${deviceTitle(device)}${thisDevice ? ' (this device)' : ''}`;
  const reasonError = reason.trim().length === 0 ? 'Say why you are stopping push here.' : null;

  const send = async (body: { reason: string; expectedRevision: number }) => {
    sent.current = body;
    try {
      await revoke.submit({ path: { id: device.id }, body });
      sent.current = null;
      setStopping(false);
    } catch {
      // revoke.error is rendered below; the reason is kept.
    }
  };
  const submit = () => {
    setAttempted(true);
    if (reasonError) return;
    void send({ reason: reason.trim(), expectedRevision: device.revision });
  };

  return (
    <View testID={`push-device-${device.id}`}>
      <ListRow
        title={title}
        detail={deviceDetail(device)}
        status={
          active
            ? { tone: 'success', label: 'Receives push' }
            : { tone: 'neutral', label: 'No longer receives push' }
        }
      />
      {active && !stopping ? (
        <View style={styles.inset}>
          <Button
            label={`Stop push to ${deviceTitle(device)}`}
            variant="secondary"
            onPress={() => setStopping(true)}
            disabled={offline}
            accessibilityHint={offline ? 'Needs a connection' : 'Asks for a reason first'}
          />
        </View>
      ) : null}
      {active && stopping ? (
        <View style={styles.form}>
          <TextField
            label="Reason"
            hint="For example: I no longer use this phone."
            value={reason}
            onChangeText={(next) => {
              setReason(next);
              sent.current = null;
              if (revoke.error) revoke.reset();
            }}
            error={attempted ? reasonError : null}
            editable={!revoke.isProcessing}
            testID={`push-reason-${device.id}`}
          />
          <View style={styles.inset}>
            <Button
              label="Stop push"
              onPress={submit}
              busy={revoke.isProcessing}
              disabled={offline}
              accessibilityHint={offline ? 'Needs a connection' : undefined}
            />
            <Button
              label="Keep receiving push"
              variant="secondary"
              onPress={() => setStopping(false)}
            />
          </View>
        </View>
      ) : null}
      {revoke.error ? (
        <CommandError
          error={revoke.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
          onReload={() => {
            revoke.reset();
            sent.current = null;
            setStopping(false);
            void queryClient.invalidateQueries({ queryKey: PUSH_DEVICES_KEY });
          }}
          notFound={{
            title: 'Device not available',
            description: 'This device is no longer registered for your account.',
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  inset: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  form: { gap: spacing.sm, paddingTop: spacing.sm },
});
