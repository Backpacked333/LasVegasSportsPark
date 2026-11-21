/**
 * Handoff M 4c Notification settings (You › Notifications; SPK-COMMS-001, SPK-COMMS-007,
 * SPK-UX-009; ADR-008 visual system v2, **Proposed**): grouped by what parents care about, not by
 * channel.
 *
 * What the API can say today (`GET`/`PATCH /v1/me/communication-preferences`: one switch per
 * channel and category, `operational` or `promotional`; the in-app operational notice is locked
 * on):
 * - "Changes and cancellations · always on": locked, with a lock glyph and the reason in words,
 *   so no one misses a moved game (operational notices cannot be turned off).
 * - "New programs for your kids": the promotional category, on every channel the account has
 *   (push, email, text). The switch saves at once (optimistic, with Undo for 5 s that sends the
 *   previous choice; a failure puts it back and says it did not save, with Try again).
 *
 * What it cannot say yet is shown as designed in the **Proposed** state (disabled, the purple
 * "Proposed" tag; nothing is faked): Game reminders, Coach asks who's going and Results and
 * standings (the API has no category per kind of operational notice), "Whose updates" per child
 * (no per-person mute), and Quiet hours (no hold window). Channel choices for operational notices,
 * calendar feeds and devices stay in "Notifications and calendar" (`/preferences`).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { useApi, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Icon } from '../../ui/Icon';
import { useOptimisticWrite } from '../../ui/optimistic';
import { personColorOf } from '../../ui/person-colors';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { StatusBadge } from '../../ui/StatusBadge';
import { SwitchRow } from '../../ui/SwitchRow';
import { Text } from '../../ui/Text';
import {
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  type,
  useTheme,
} from '../../ui/theme';

type Preferences = Schema<'CommunicationPreferences'>;
type Channel = Schema<'DeliveryChannel'>;

const KEY = ['api', '/me/communication-preferences'] as const;

/** Whether promotional messages reach the person on any channel they can be switched on. */
export function promotionalOn(prefs: Preferences): boolean {
  return prefs.preferences.some((p) => p.category === 'promotional' && p.enabled);
}

/** The promotional channels the person can switch (not locked). */
export function promotionalChannels(prefs: Preferences): Channel[] {
  return prefs.preferences
    .filter((p) => p.category === 'promotional' && !p.locked)
    .map((p) => p.channel);
}

function Row({
  title,
  detail,
  trailing,
  first,
  testID,
}: {
  title: string;
  detail?: string;
  trailing: ReactNode;
  first?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.row, first ? null : styles.divider]} testID={testID}>
      <View style={styles.flex}>
        <Text style={styles.title}>{title}</Text>
        {detail ? (
          <Text variant="footnote" tone="muted">
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

/** A switch of the design the API cannot back yet: shown on, disabled, tagged "Proposed". */
function ProposedSwitch({ label }: { label: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.proposed}>
      <StatusBadge tone="pending" label="Proposed" />
      <Switch
        value
        disabled
        accessibilityLabel={`${label}, proposed: not available yet`}
        accessibilityState={{ disabled: true, checked: true }}
        trackColor={{ true: colors.control, false: colors.control }}
        thumbColor={colors.background}
      />
    </View>
  );
}

function Settings({ prefs }: { prefs: Preferences }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const api = useApi();
  const queryClient = useQueryClient();
  const offline = useConnectivity().reachable === false;
  const run = useOptimisticWrite();
  const { people } = useHousehold();
  const children = people.filter((p) => !p.self);
  const [programs, setPrograms] = useState<boolean | null>(null);
  const [quiet, setQuiet] = useState(false);
  const shown = programs ?? promotionalOn(prefs);
  const channels = promotionalChannels(prefs);

  const send = (enabled: boolean) =>
    api.patch('/me/communication-preferences', {
      body: {
        preferences: channels.map((channel) => ({
          channel,
          category: 'promotional' as const,
          enabled,
        })),
      },
      intent: api.newIntent(),
    });

  const togglePrograms = (next: boolean) => {
    const previous = shown;
    run({
      apply: () => setPrograms(next),
      revert: () => setPrograms(previous),
      commit: () => send(next),
      undo: () => send(previous),
      success: next ? 'New programs: on.' : 'New programs: off.',
      failure: "That setting didn't save.",
      onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
    });
  };

  return (
    <View testID="notification-settings">
      <View style={styles.card}>
        <Row
          first
          title="Changes and cancellations"
          detail="Field, time, weather · always on"
          trailing={
            <View
              accessible
              accessibilityLabel="Always on: changes and cancellations cannot be turned off"
              style={styles.lock}
            >
              <Icon name="lock" size={20} color={theme.colors.textMuted} />
            </View>
          }
          testID="notify-changes"
        />
        <Row
          title="Game reminders"
          detail="The evening before and 1 h before"
          trailing={<ProposedSwitch label="Game reminders" />}
        />
        <Row
          title="Coach asks who's going"
          detail="Answer from the notification"
          trailing={<ProposedSwitch label="Coach asks who's going" />}
        />
        <Row
          title="Results and standings"
          detail="After each game"
          trailing={<ProposedSwitch label="Results and standings" />}
        />
        <View style={styles.divider}>
          <SwitchRow
            label="New programs for your kids"
            description="Max 2 a month"
            value={shown}
            onChange={togglePrograms}
            disabled={offline || channels.length === 0}
            testID="notify-programs"
          />
        </View>
      </View>

      {children.length > 0 ? (
        <>
          <Text style={styles.heading} accessibilityRole="header">
            Whose updates
          </Text>
          <View style={styles.card}>
            {children.map((child, index) => (
              <View
                key={child.id}
                style={[styles.row, index === 0 ? null : styles.divider]}
                testID={`notify-person-${child.id}`}
              >
                <Avatar
                  name={child.givenName}
                  id={child.id}
                  personColor={personColorOf(theme, child.slot)}
                  size={36}
                  decorative
                />
                <Text style={[styles.title, styles.flex]}>{child.givenName}</Text>
                <ProposedSwitch label={`Updates for ${child.givenName}`} />
              </View>
            ))}
          </View>
          <Text variant="footnote" tone="muted" style={styles.note}>
            Turning off a child would mute everything for them except changes.
          </Text>
        </>
      ) : null}

      <Pressable
        onPress={() => setQuiet(true)}
        accessibilityRole="button"
        accessibilityLabel="Quiet hours, 9 PM to 7 AM, proposed"
        style={[styles.card, styles.quiet]}
        testID="notify-quiet"
      >
        <Icon name="bedtime" size={22} color={theme.colors.pending} />
        <View style={styles.flex}>
          <Text style={styles.title}>Quiet hours</Text>
          <Text variant="footnote" tone="muted">
            9 PM – 7 AM · changes still come through
          </Text>
        </View>
        <StatusBadge tone="pending" label="Proposed" />
        <Icon name="chevron_right" size={22} color={theme.colors.primary} />
      </Pressable>

      <Pressable
        onPress={() => router.push('/preferences')}
        accessibilityRole="link"
        accessibilityLabel="Channels, calendar feeds and devices"
        style={styles.more}
      >
        <Text style={styles.moreText}>Channels, calendar feeds and devices</Text>
      </Pressable>

      <Sheet open={quiet} onClose={() => setQuiet(false)} title="Quiet hours">
        <View style={styles.sheet} testID="notify-quiet-proposed">
          <StatusBadge tone="pending" label="Proposed" />
          <Text variant="body">
            Holding reminders and news until 7 AM is coming. Changes and cancellations would still
            come through at any hour.
          </Text>
        </View>
      </Sheet>
    </View>
  );
}

export function NotificationSettingsScreen() {
  const prefs = useApiQuery({ path: '/me/communication-preferences' });
  return (
    <Screen>
      <RequireSession what="your notification settings">
        <QueryBoundary
          query={prefs}
          label="your notification settings"
          empty={{ title: 'Not available', description: '' }}
        >
          {(data) => <Settings prefs={data} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  flex: { flex: 1, gap: 2 },
  card: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.md,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  title: { ...fonts.semibold, fontSize: 16, lineHeight: 21, color: colors.text },
  lock: { minWidth: MIN_TOUCH_SIZE, alignItems: 'center' },
  proposed: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  heading: {
    ...type.title3,
    ...fonts.semibold,
    color: colors.text,
    paddingHorizontal: layout.gutter,
    marginTop: spacing.xl,
  },
  note: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.md,
    marginTop: spacing.lg,
  },
  more: {
    minHeight: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    paddingHorizontal: layout.gutter,
    marginTop: spacing.md,
  },
  moreText: { ...fonts.semibold, fontSize: 15, color: colors.primary },
  sheet: { gap: spacing.md },
}));
