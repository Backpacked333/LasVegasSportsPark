/**
 * SCR-C-36 Preferences (SPK-UX-001, SPK-COMMS-001, SPK-COMMS-007, SPK-COMMS-008, DEC-062,
 * POL-024).
 *
 * - Communication preferences (`GET`/`PATCH /v1/me/communication-preferences`): "Essential notices"
 *   and "Promotional messages" are separate sections (SPK-COMMS-007, journeys.md section 3). The
 *   in-app essential notice is locked on by the API (`locked`) and shown as "Always on", never as
 *   a switch. Defaults come from the API (`stored: false` reads "Facility default"); which channels
 *   are used at all is DEC-062 (Operator/privacy owner), shown as pending.
 * - Push on this device: no push module or device registration exists yet (DEC-061, DEC-020;
 *   the API has no device endpoint), so it is shown as not available; when the operating system
 *   denies push, the screen explains it and that in-app notices continue.
 * - Private calendar feeds with revocable links (CalendarFeedsSection, SPK-COMMS-008).
 *
 * States: loading; empty: not applicable (the API always returns the full matrix); ready;
 * validation failure: not applicable (a locked notice cannot be switched; the API's
 * VALIDATION_FAILED is shown if it happens); permission restriction (push denied by the operating
 * system: explained, in-app notices kept); stale version: not applicable, refreshed on return;
 * offline (changes disabled, nothing queued); processing (Save busy); success ("Preferences
 * saved"); partial completion: not permitted (one PATCH); recovery required: not applicable, a
 * failed save keeps the choices and offers "Try again" under the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand, type CommandRequest } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { CommandError } from '../account/components/CommandError';
import { Paragraph, SectionHeader, SwitchRow } from '../account/components/forms';
import { CalendarFeedsSection } from './CalendarFeedsSection';
import { usePushPermissionStatus } from './push-permission';

type Preferences = Schema<'CommunicationPreferences'>;
type Preference = Schema<'CommunicationPreference'>;
type Category = Preference['category'];
type Channel = Preference['channel'];

export const CATEGORY_TITLES: Record<Category, string> = {
  operational: 'Essential notices',
  promotional: 'Promotional messages',
};
const CATEGORY_DETAILS: Record<Category, string> = {
  operational: 'Notices about your activities, registrations and payments.',
  promotional: 'News and marketing from the facility.',
};
export const CHANNEL_LABELS: Record<Channel, string> = {
  in_app: 'In the app',
  push: 'Push notifications',
  email: 'Email',
  sms: 'Text messages (SMS)',
};
const CATEGORIES: readonly Category[] = ['operational', 'promotional'];
const PREFERENCES_KEY = ['api', '/me/communication-preferences'] as const;

const keyOf = (p: Pick<Preference, 'category' | 'channel'>) => `${p.category}:${p.channel}`;

export function PreferencesScreen() {
  return (
    <Screen>
      <RequireSession what="your preferences">
        <PreferencesContent />
      </RequireSession>
    </Screen>
  );
}

function PreferencesContent() {
  const prefs = useApiQuery({ path: '/me/communication-preferences' });
  return (
    <View>
      <QueryBoundary
        query={prefs}
        label="your preferences"
        empty={{ title: 'No preferences', description: '' }}
        unavailableOffline={['changing preferences']}
      >
        {(data) => <PreferencesForm data={data} />}
      </QueryBoundary>
      <PushOnThisDevice />
      <CalendarFeedsSection />
    </View>
  );
}

function PreferencesForm({ data }: { data: Preferences }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  // Unsaved choices; kept when a save fails (SPK-UX-008).
  const [draft, setDraft] = useState<Readonly<Record<string, boolean>>>({});
  const save = useApiCommand('patch', '/me/communication-preferences', {
    invalidate: [PREFERENCES_KEY],
  });
  const [saved, setSaved] = useState(false);

  const changes = data.preferences.filter(
    (p) => !p.locked && draft[keyOf(p)] !== undefined && draft[keyOf(p)] !== p.enabled,
  );

  // The submitted preferences of the intent in flight (§4.9): "Try again" resends exactly them, so
  // a refetch that already shows the change applied never turns the retry into an empty save under
  // a new key. Cleared on success and when the choices change.
  const sent = useRef<CommandRequest<'patch', '/me/communication-preferences'> | null>(null);

  const send = async (request: CommandRequest<'patch', '/me/communication-preferences'>) => {
    sent.current = request;
    try {
      await save.submit(request);
      sent.current = null;
      setDraft({});
      setSaved(true);
    } catch {
      // save.error is rendered below; the choices are kept.
    }
  };

  const submit = () =>
    send({
      body: {
        preferences: changes.map((p) => ({
          channel: p.channel,
          category: p.category,
          enabled: draft[keyOf(p)] as boolean,
        })),
      },
    });

  const retry = () => (sent.current ? send(sent.current) : submit());

  return (
    <View>
      <StateView
        variant="pending-decision"
        subject="The choice of channels the facility uses"
        decisions={['DEC-062']}
        owner="Operator/privacy owner"
      />
      {CATEGORIES.map((category) => (
        <View key={category}>
          <SectionHeader title={CATEGORY_TITLES[category]} detail={CATEGORY_DETAILS[category]} />
          {data.preferences
            .filter((p) => p.category === category)
            .map((p) =>
              p.locked ? (
                <ListRow
                  key={keyOf(p)}
                  title={CHANNEL_LABELS[p.channel]}
                  detail="Essential notices always appear in the app and cannot be switched off."
                  status={{ tone: 'success', label: 'Always on' }}
                  testID={`pref-${keyOf(p)}`}
                />
              ) : (
                <SwitchRow
                  key={keyOf(p)}
                  label={CHANNEL_LABELS[p.channel]}
                  accessibilityLabel={`${CHANNEL_LABELS[p.channel]} for ${CATEGORY_TITLES[category].toLowerCase()}`}
                  detail={p.stored ? 'Your choice' : 'Facility default'}
                  value={draft[keyOf(p)] ?? p.enabled}
                  disabled={offline || save.isProcessing}
                  onChange={(enabled) => {
                    setSaved(false);
                    sent.current = null;
                    if (save.error) save.reset();
                    setDraft((current) => ({ ...current, [keyOf(p)]: enabled }));
                  }}
                  testID={`pref-${keyOf(p)}`}
                />
              ),
            )}
        </View>
      ))}
      <View style={styles.actions}>
        <Button
          label="Save preferences"
          onPress={() => void submit()}
          busy={save.isProcessing}
          disabled={offline || changes.length === 0}
          accessibilityHint={
            offline ? 'Needs a connection' : changes.length === 0 ? 'No changes to save' : undefined
          }
        />
        {saved && changes.length === 0 ? (
          <StatusBadge tone="success" label="Preferences saved" />
        ) : null}
        {offline ? (
          <Paragraph muted inset={false}>
            Changes need a connection and are not queued.
          </Paragraph>
        ) : null}
      </View>
      {save.error ? <CommandError error={save.error} onRetry={() => void retry()} /> : null}
    </View>
  );
}

function PushOnThisDevice() {
  const status = usePushPermissionStatus();
  return (
    <View>
      <SectionHeader title="Push on this device" />
      {status === null ? (
        <StateView variant="loading" label="push settings" />
      ) : status === 'denied' ? (
        <StateView
          variant="unavailable"
          title="Push is turned off for this app"
          description="Your device settings block notifications from this app. Essential notices still appear in the app's inbox. To get push, allow notifications for this app in your device settings."
        />
      ) : status === 'unavailable' ? (
        <StateView
          variant="unavailable"
          title="Push is not set up in this version"
          description="This version of the app does not register for push notifications. Essential notices always appear in the app's inbox."
        />
      ) : (
        <StateView
          variant="unavailable"
          title="This device is not registered for push yet"
          description="Registering a device for push is not available yet. Essential notices always appear in the app's inbox."
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, gap: spacing.sm },
});
