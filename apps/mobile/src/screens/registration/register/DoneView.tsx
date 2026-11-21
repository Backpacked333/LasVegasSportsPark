/**
 * Register · Done, the confirmation that sets up the season (redesign handoff M 1g; INTERACTIONS
 * "1e–1g" rows 8 and 9; SPK-UX-004, SPK-PLACE-001, SPK-REG-012). Shown once the API reports the
 * checkout completed; it says what happens next instead of only "Confirmed":
 *
 * - "10 Saturdays added to Calendar · First: Sat, Mar 7, 9:00 AM" (the registered activity's
 *   sessions on the facility clock; Calendar reads them from the API, nothing is copied);
 * - "Team placement": ◷ "We'll tell you before the first game" while the API's placement is open,
 *   ✓ the team once it names one (never a date of our own);
 * - "Uniform · Youth M · Pick up at the front desk" for a uniform bought with the place;
 * - "Sign forms now" opens the sign sheet for any form the new activity still needs (hidden when
 *   nothing is left to sign);
 * - one sibling suggestion: another child's activity by age (`GET /v1/me/offering-suggestions`),
 *   the same day of the week first ("Same Saturdays, for Leo");
 * - "Add to phone": the sessions as a calendar file (`ics.ts`): opened as a file on the web and
 *   shared on a phone (no calendar module is installed: adding straight to the device calendar is
 *   **Proposed**); "Done" goes Home.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Pressable, Share, View } from 'react-native';
import { useInsets } from '../../../ui/insets';
import { useApiQuery } from '../../../api/useApiQuery';
import { artworkFor } from '../../../artwork/artworkFor';
import { illustrations } from '../../../artwork/manifest';
import { lengthWords, meetingPattern, weekLabel } from '../../../features/register/fit';
import { sessionsIcs } from '../../../features/register/ics';
import { useFormsStatus } from '../../../features/registration/forms';
import { useApiRecords } from '../../../features/registration/queries';
import { registrationRoutes } from '../../../features/registration/routes';
import { formatDay, formatTime } from '../../../features/today/time';
import { useNow } from '../../../providers/AppProviders';
import { LiveRegion, sentences } from '../../../ui/announce';
import { Artwork } from '../../../ui/Artwork';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Icon } from '../../../ui/Icon';
import { Sheet } from '../../../ui/Sheet';
import { StatusBadge } from '../../../ui/StatusBadge';
import { Text } from '../../../ui/Text';
import { elevation, fonts, layout, makeStyles, radius, spacing, useTheme } from '../../../ui/theme';
import { FormsContent } from '../RequiredFormsScreen';
import { namesList } from './WhoStep';

type Checkout = Schema<'Checkout'>;
type Basket = Schema<'Basket'>;
type Enrollment = Schema<'Enrollment'>;
type PlacementRequest = Schema<'PlacementRequest'>;

/** "Maya is in.", "Maya and Leo are in.", "You're in." */
export function inHeadline(names: readonly string[]): string {
  if (names.length === 1 && names[0] === 'You') return "You're in.";
  return `${namesList(names)} ${names.length > 1 ? 'are' : 'is'} in.`;
}

/** "10 Saturdays added to Calendar": the sessions of one weekly activity, or of a camp. */
export function calendarLine(count: number, pattern: string | null, length: string | null): string {
  const day = pattern?.split(' ')[0];
  if (day && day !== 'Weekdays' && count > 1) return `${count} ${day} added to Calendar`;
  if (length) return `${length.replace(/^1 session$/u, '1 session')} added to Calendar`;
  return `${count} ${count === 1 ? 'session' : 'sessions'} added to Calendar`;
}

function Fact({
  icon,
  tone,
  title,
  detail,
  first,
}: {
  icon: string;
  tone: 'accent' | 'pending';
  title: string;
  detail: string;
  first?: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View
      style={[styles.fact, first ? null : styles.divider]}
      accessible
      accessibilityLabel={`${title}. ${detail}`}
    >
      <Icon name={icon} size={22} color={tone === 'pending' ? colors.pending : colors.primary} />
      <View style={styles.factWords}>
        <Text variant="callout" style={styles.bold}>
          {title}
        </Text>
        <Text variant="footnote" tone="muted">
          {detail}
        </Text>
      </View>
    </View>
  );
}

export function DoneView({
  checkout,
  basket,
  names,
  enrollments,
  placements,
}: {
  checkout: Checkout;
  basket: Basket | undefined;
  names: (personId: string) => string;
  enrollments: Record<string, { data: Enrollment | undefined }>;
  placements: Record<string, { data: PlacementRequest | undefined }>;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const insets = useInsets();
  const now = useNow();
  const [signing, setSigning] = useState(false);
  const lines = (basket?.lines ?? []).filter(
    (l) => l.outcome !== 'released' && l.outcome !== 'failed',
  );
  const people = [...new Set(lines.map((l) => l.participantPersonId))];
  const offeringIds = [...new Set(lines.map((l) => l.offeringId))];
  const offerings = useApiRecords('/offerings/{id}', offeringIds);
  const sessions = useApiRecords('/offerings/{id}/sessions', offeringIds);
  const first = offeringIds[0] ? offerings[offeringIds[0]]?.data : undefined;
  const zone = first?.facility.timezone ?? 'UTC';
  const allSessions = offeringIds
    .flatMap((id) => sessions[id]?.data ?? [])
    .filter((s) => s.status !== 'canceled')
    .sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart));
  const camp = offeringIds.length > 1;
  const activityName = camp && first ? (first.name.split(' · ')[0] ?? first.name) : first?.name;
  const pattern =
    !camp && sessions[offeringIds[0] ?? '']?.data ? meetingPattern(allSessions, zone) : null;
  const length = !camp && allSessions.length > 0 ? lengthWords(allSessions, zone) : null;
  const firstSession = allSessions[0];
  const placementsOpen = Object.values(placements).some(
    (p) => p.data && (p.data.status === 'unassigned' || p.data.status === 'proposed'),
  );
  const assigned = Object.values(placements).find((p) => p.data?.status === 'assigned')?.data;
  const hasPlacement = Object.values(enrollments).some((e) => e.data?.placementRequestId);
  const uniforms = lines.filter((l) => l.uniform);
  const forms = useFormsStatus(
    lines.map((l) => ({
      participantPersonId: l.participantPersonId,
      policyVersionIds: l.policies.requiredFormPolicyVersionIds,
    })),
    basket !== undefined,
  );

  // One sibling suggestion: another child of the household, the same day of the week first.
  const sibling = useApiQuery({ path: '/me' }).data?.authorities.find(
    (a) => !people.includes(a.subjectPersonId) && a.permissions.includes('register'),
  )?.subjectPersonId;
  const suggestions = useApiQuery({
    path: '/me/offering-suggestions',
    request: { query: { participantPersonId: sibling ?? '', limit: 6 } },
    enabled: sibling !== undefined,
    staleTime: 60_000,
  });
  const siblingNames = useApiRecords('/people/{id}', sibling ? [sibling] : []);
  const suggested = (suggestions.data?.items ?? [])
    .map((s) => s.offering)
    .filter((o) => !offeringIds.includes(o.id));
  const suggestedSessions = useApiRecords(
    '/offerings/{id}/sessions',
    suggested.map((o) => o.id),
  );
  const day = pattern?.split(' ')[0];
  const sameDay = day
    ? suggested.find((o) => {
        const s = suggestedSessions[o.id]?.data;
        return s ? meetingPattern(s, o.facility.timezone)?.startsWith(day) === true : false;
      })
    : undefined;
  const pick = sameDay ?? suggested[0];
  const siblingName = sibling ? siblingNames[sibling]?.data?.givenName : undefined;
  const pickPattern =
    pick && suggestedSessions[pick.id]?.data
      ? meetingPattern(suggestedSessions[pick.id]?.data ?? [], pick.facility.timezone)
      : null;

  const addToPhone = () => {
    const ics = sessionsIcs({
      title: activityName ?? 'Activity',
      location: first?.locationLabel ?? first?.facility.name ?? null,
      sessions: allSessions,
      now,
    });
    if (Platform.OS === 'web') {
      void Linking.openURL(`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`);
      return;
    }
    Share.share({ title: activityName ?? 'Activity', message: ics }).catch(() => undefined);
  };
  const headline = inHeadline(people.map(names));
  const sub = [activityName, checkout.receipt ? 'Your receipt is under You › Payments.' : null]
    .filter(Boolean)
    .join('. ');

  return (
    <View style={styles.root} testID="register-done">
      <View style={styles.content}>
        <Artwork
          source={illustrations.success}
          aspectRatio={390 / 260}
          contentFit="contain"
          testID="outcome-success-art"
        />
        <LiveRegion announcement={sentences('Confirmed', headline, sub)} style={styles.head}>
          <StatusBadge tone="success" label="Confirmed" testID="outcome-status" />
          <Text variant="title1" heading style={styles.headline}>
            {headline}
          </Text>
          <Text variant="body" tone="muted">
            {sub}
          </Text>
        </LiveRegion>
        <Card style={styles.facts} testID="done-next">
          {firstSession ? (
            <Fact
              first
              icon="event_available"
              tone="accent"
              title={calendarLine(
                allSessions.length,
                pattern,
                camp ? `${allSessions.length} days` : length,
              )}
              detail={`First: ${formatDay(firstSession.scheduledStart, zone)}, ${formatTime(firstSession.scheduledStart, zone)}`}
            />
          ) : null}
          {hasPlacement ? (
            <Fact
              icon="schedule"
              tone={assigned ? 'accent' : 'pending'}
              title="Team placement"
              detail={
                assigned
                  ? `✓ ${assigned.assignedTeamName ?? 'Placed on a team'}`
                  : placementsOpen
                    ? "◷ We'll tell you before the first game"
                    : '◷ Being arranged'
              }
            />
          ) : null}
          {uniforms.map((l) => (
            <Fact
              key={l.id}
              icon="checkroom"
              tone="accent"
              title={`${l.uniform?.name ?? 'Uniform'} · ${l.uniform?.size ?? ''}`}
              detail={
                people.length > 1
                  ? `For ${names(l.participantPersonId)} · pick up at the front desk`
                  : 'Pick up at the front desk'
              }
            />
          ))}
        </Card>
        {forms.outstanding > 0 ? (
          <Button
            label="Sign forms now"
            variant="tonal"
            icon="edit_document"
            onPress={() => setSigning(true)}
            testID="done-sign"
          />
        ) : null}
        {pick && siblingName ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${day && sameDay ? `Same ${day}` : 'Also'}, for ${siblingName}: ${pick.name}`}
            onPress={() => router.push(registrationRoutes.offering(pick.id))}
            style={[styles.suggestion, elevation(theme, 'card')]}
            testID="done-sibling"
          >
            <Artwork
              source={artworkFor(pick, 'square').source}
              aspectRatio={1}
              style={styles.suggestionArt}
            />
            <View style={styles.factWords}>
              <Text variant="footnote" tone="muted" style={styles.bold}>
                {day && sameDay ? `Same ${day}, for ${siblingName}` : `For ${siblingName}`}
              </Text>
              <Text variant="callout" style={styles.bold}>
                {[
                  pick.kind === 'camp' ? weekLabel(pick.name) : pick.name,
                  pickPattern?.split(' ').slice(1).join(' '),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Icon name="chevron_right" size={22} color={theme.colors.primary} />
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.half}>
          <Button
            label="Add to phone"
            variant="secondary"
            size="lg"
            block
            onPress={addToPhone}
            disabled={allSessions.length === 0}
            testID="done-add-to-phone"
          />
        </View>
        <View style={styles.half}>
          <Button
            label="Done"
            size="lg"
            block
            onPress={() => router.replace('/')}
            testID="done-done"
          />
        </View>
      </View>
      <Sheet
        open={signing}
        onClose={() => {
          setSigning(false);
          forms.refetch();
        }}
        title="Forms to sign"
      >
        <FormsContent source={{ basketId: checkout.basketId }} embedded />
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  content: { paddingHorizontal: layout.gutter, paddingTop: spacing.md, gap: spacing.lg },
  head: { gap: 6 },
  headline: { fontSize: 30, lineHeight: 36 },
  facts: { paddingVertical: spacing.xs },
  fact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  factWords: { flex: 1, gap: 1 },
  bold: { ...fonts.semibold },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
  },
  suggestionArt: { width: 56, borderRadius: 14 },
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.md,
    marginTop: 'auto',
  },
  half: { flex: 1 },
}));
