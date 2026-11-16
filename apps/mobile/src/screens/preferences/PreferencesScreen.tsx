/**
 * SCR-C-36 Notifications and calendar, the preferences screen (SPK-UX-001, SPK-COMMS-001, SPK-COMMS-007, SPK-COMMS-008, DEC-062,
 * POL-024).
 *
 * - Communication preferences (`GET`/`PATCH /v1/me/communication-preferences`): "Essential notices"
 *   and "Promotional messages" are separate sections (SPK-COMMS-007, journeys.md section 3). The
 *   in-app essential notice is locked on by the API (`locked`) and shown as "Always on", never as
 *   a switch. Defaults come from the API (`stored: false` reads "Facility default"); which channels
 *   are used at all is DEC-062 (Operator/privacy owner), shown as pending.
 * - Push (PushDevicesSection): the devices registered for push (`GET /v1/me/push-devices`) with
 *   "Stop push" (revoke); registering this install waits on DEC-061 and DEC-020 (no push module in
 *   this build, shown as pending); when the operating system denies push, the screen explains it
 *   and that in-app notices continue.
 * - Private calendar feeds with revocable links (CalendarFeedsSection, SPK-COMMS-008).
 * - Appearance: the Legends mode switch (`ui/LegendsModeToggle`), a display preference kept on
 *   this device and not sent to the API; shown first, whatever the API answers below.
 *
 * Undecided channels are hidden (PA-11, ADR-008): which channels the facility uses is DEC-062
 * and the messaging providers are DEC-020, so only the in-app rows are shown. In their place one
 * plain message says what to do now ("Check your inbox in the app for notices."), with the
 * decisions in "Details for support". The API's matrix and any choice stored for the hidden
 * channels are left as they are: a save sends only the rows the customer changed.
 *
 * States: loading; empty: not applicable (the API always returns the full matrix); ready;
 * validation failure: not applicable (a locked notice cannot be switched; the API's
 * VALIDATION_FAILED is shown if it happens; a reason is required to stop push to a device);
 * permission restriction (push denied by the operating system: explained, in-app notices kept);
 * stale version: refreshed on return; STALE_REVISION on stopping push reloads the device list;
 * offline (changes disabled, nothing queued); processing (Save busy); success ("Preferences
 * saved"); partial completion: not permitted (one PATCH); recovery required: not applicable, a
 * failed save keeps the choices and offers "Try again" under the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useApiCommand, type CommandRequest } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { pendingMessageFor } from '../../copy/pending';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LegendsModeToggle } from '../../ui/LegendsModeToggle';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { SwitchRow } from '../../ui/SwitchRow';
import { Text } from '../../ui/Text';
import { spacing } from '../../ui/theme';
import { CommandError } from '../../ui/CommandError';
import { CalendarFeedsSection } from './CalendarFeedsSection';
import { PushDevicesSection } from './PushDevicesSection';

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
/** The channels shown: in-app only while DEC-062 and DEC-020 are open (the others are hidden). */
export const SHOWN_CHANNELS: readonly Channel[] = ['in_app'];
/** The screen's title (the You hub row and the stack header). */
export const PREFERENCES_TITLE = 'Notifications and calendar';
const PREFERENCES_KEY = ['api', '/me/communication-preferences'] as const;

const keyOf = (p: Pick<Preference, 'category' | 'channel'>) => `${p.category}:${p.channel}`;

export function PreferencesScreen() {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Pull to refresh: every read on the screen again.
  const refresh = () => {
    setRefreshing(true);
    void queryClient.refetchQueries({ type: 'active' }).finally(() => setRefreshing(false));
  };
  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Section title="Appearance" subtitle="How the app looks on this device." variant="carousel">
        <LegendsModeToggle testID="preferences-legends-mode" />
      </Section>
      <RequireSession what="your preferences">
        <PreferencesContent />
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/preferences.tsx. */
export function PreferencesRoute() {
  return (
    <>
      <Stack.Screen options={{ title: PREFERENCES_TITLE }} />
      <PreferencesScreen />
    </>
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
      <PushDevicesSection />
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
      <Section title="Notifications" variant="plain">
        <StateView
          variant="pending-decision"
          subject="Email, text and push notices"
          decisions={['DEC-062', 'DEC-020']}
          owner="Operator/privacy owner (DEC-062); Technical lead/account owners (DEC-020)"
          message={pendingMessageFor(['DEC-062', 'DEC-020'])}
        />
      </Section>
      {CATEGORIES.map((category) => (
        <Section
          key={category}
          title={CATEGORY_TITLES[category]}
          subtitle={CATEGORY_DETAILS[category]}
        >
          {data.preferences
            .filter((p) => p.category === category && SHOWN_CHANNELS.includes(p.channel))
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
                  description={p.stored ? 'Your choice' : 'Facility default'}
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
        </Section>
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
          <Text variant="body" tone="muted">
            Changes need a connection and are not queued.
          </Text>
        ) : null}
      </View>
      {save.error ? <CommandError error={save.error} onRetry={() => void retry()} /> : null}
    </View>
  );
}

const styles = {
  actions: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, gap: spacing.sm },
} as const;
