/**
 * Handoff M 4d Message the coach (from "Message the coach" on Game day M 1i, or a cancelled game's
 * card M 3g; ADR-008 visual system v2). **Pending decision**: a messaging API (handoff open
 * decision 8: team threads, one-to-one through the park with phone numbers private, SMS fallback)
 * does not exist, so the screen is built as designed in its **Proposed** state, with nothing faked:
 *
 * - The header names the coach (the team's captain, as a youth team's coach is recorded, from the
 *   team workspace `GET /v1/team-entries/{id}` roles, named through `GET /v1/person-names` when the account may read the name) and the team.
 * - The thread starts with the event it is about: the game's card (`GET /v1/fixtures/{id}`), with a
 *   cancelled game marked ✕ in words. No messages are shown: none can exist yet.
 * - Quick replies ("{child} will be late", "Thank you!", "Who has the ball?") and the message field
 *   are drawn disabled with the purple "Proposed" tag, and the screen says what to do meanwhile
 *   (write to the desk, which reaches the coach through the park).
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useContext } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useApiQuery } from '../../api/useApiQuery';
import { useHousehold } from '../../features/home/household';
import { fixtureTitle } from '../../features/today/fixture-model';
import { usePersonNames } from '../../features/today/queries';
import { formatWhen, zoneOf } from '../../features/today/time';
import { RequireSession } from '../../session/RequireSession';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import {
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  useTheme,
} from '../../ui/theme';

/** The quick replies of the design, with the child's name. */
export function quickReplies(childName: string | null): string[] {
  return [
    childName ? `${childName} will be late` : "We'll be late",
    'Thank you!',
    'Who has the ball?',
  ];
}

function Thread({ fixtureId }: { fixtureId: string | null }) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const insets = useContext(SafeAreaInsetsContext);
  const { me, people } = useHousehold();
  const fixture = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: fixtureId ?? '' } },
    enabled: !!fixtureId,
  });
  const entryId = fixture.data?.home.entryId ?? null;
  const home = useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: entryId ?? '' } },
    enabled: !!entryId,
  });
  const awayId = fixture.data?.away?.entryId ?? null;
  const away = useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: awayId ?? '' } },
    enabled: !!awayId && home.isError,
  });
  const workspace = home.data ?? away.data;
  // A youth team's coach is the team's captain in the API (team roles: captain, co-captain).
  const coachId =
    workspace?.roles.find((r) => r.role === 'captain' && r.effectiveTo === null)?.personId ?? null;
  const names = usePersonNames(coachId ? [coachId] : [], me.data);
  const coachName = coachId ? names.get(coachId) : undefined;
  const coach = coachName && coachName !== 'Family member' ? `Coach ${coachName}` : 'The coach';
  const roster = new Set((workspace?.roster ?? []).map((m) => m.personId));
  const child = people.find((p) => !p.self && roster.has(p.id)) ?? people.find((p) => !p.self);
  const detail = fixture.data;
  const zone = zoneOf(detail?.venue?.timezone).zone;
  const cancelled = detail?.status === 'canceled';

  return (
    <View style={styles.page} testID="message-coach">
      <View style={[styles.bar, { paddingTop: (insets?.top ?? 0) + spacing.xs }]}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.barButton}
        >
          <Icon name="arrow_back" size={24} color={theme.colors.primary} />
        </Pressable>
        <Avatar name={coach} id={coachId ?? undefined} size={44} decorative />
        <View style={styles.flex}>
          <Text style={styles.coach} accessibilityRole="header">
            {coach}
          </Text>
          <Text variant="footnote" tone="muted">
            {workspace?.team.name ?? 'Your team'}
          </Text>
        </View>
      </View>

      <View style={styles.thread}>
        <Text variant="footnote" tone="muted" style={styles.day}>
          Today
        </Text>
        {detail ? (
          <View
            style={[styles.event, cancelled ? styles.eventCancelled : null]}
            accessible
            accessibilityLabel={`${fixtureTitle(detail)}${cancelled ? ', cancelled' : ''}${detail.scheduledStart ? `, ${formatWhen(detail.scheduledStart, zone)}` : ''}`}
            testID="message-event"
          >
            {cancelled ? <Text style={styles.cross}>✕</Text> : null}
            <Icon name="sports_soccer" size={18} color={theme.colors.textMuted} />
            <Text variant="callout" style={styles.flex}>
              <Text style={styles.bold}>{fixtureTitle(detail)}</Text>
              {cancelled ? ' cancelled' : ''}
              {detail.scheduledStart ? ` · ${formatWhen(detail.scheduledStart, zone)}` : ''}
            </Text>
          </View>
        ) : null}
        <View style={styles.proposedBox} testID="message-proposed">
          <StatusBadge tone="pending" label="Proposed" />
          <Text variant="callout">
            Messaging the coach through the park is coming: your number stays private both ways. For
            now, write to the front desk and they will pass it on.
          </Text>
          <Button
            label="Write to the desk"
            variant="secondary"
            onPress={() => router.push('/support')}
          />
        </View>
      </View>

      <View style={styles.composer}>
        <View style={styles.replies} accessibilityLabel="Quick replies, proposed">
          {quickReplies(child?.givenName ?? null).map((reply) => (
            <View key={reply} style={styles.reply} accessibilityState={{ disabled: true }}>
              <Text style={styles.replyText}>{reply}</Text>
            </View>
          ))}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            editable={false}
            placeholder={`Message ${coachName && coachName !== 'Family member' ? coachName : 'the coach'}`}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel="Message, proposed: not available yet"
            accessibilityState={{ disabled: true }}
            style={styles.input}
          />
          <View style={styles.send} accessibilityElementsHidden>
            <Icon name="arrow_upward" size={22} color={theme.colors.primaryText} />
          </View>
        </View>
      </View>
    </View>
  );
}

export function MessageCoachScreen({ fixtureId }: { fixtureId: string | null }) {
  return (
    <Screen>
      <RequireSession what="messages">
        <Thread fixtureId={fixtureId} />
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/messages/coach?fixtureId=<id>` (an opaque id only). */
export function MessageCoachRoute() {
  const { fixtureId } = useLocalSearchParams<{ fixtureId?: string }>();
  return <MessageCoachScreen fixtureId={typeof fixtureId === 'string' ? fixtureId : null} />;
}

const useStyles = makeStyles(({ colors }) => ({
  page: { flex: 1 },
  flex: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barButton: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coach: { ...fonts.bold, fontSize: 17, lineHeight: 22, color: colors.text },
  thread: { padding: layout.gutter, gap: spacing.md },
  day: { textAlign: 'center' },
  event: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  eventCancelled: { borderColor: colors.danger },
  cross: { ...fonts.bold, color: colors.danger },
  bold: { ...fonts.bold },
  proposedBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'flex-start',
  },
  composer: {
    marginTop: 'auto',
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  replies: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  reply: {
    paddingHorizontal: spacing.md,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.control,
    opacity: 0.6,
  },
  replyText: { ...fonts.semibold, fontSize: 14, color: colors.text },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    color: colors.text,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.control,
  },
}));
