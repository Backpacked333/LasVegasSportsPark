/**
 * Waitlist offer, decide before the clock runs out (redesign handoff M 2e; INTERACTIONS "2e";
 * key flow "Take a waitlist place"; SPK-REG-008, SPK-AT-006, SPK-SCHED-008, DEC-006).
 *
 * - The time left is big and in plain words (hours and minutes; minutes and seconds under an
 *   hour), with the exact deadline on the facility's clock: "Until Fri 9:41 AM. After that it goes
 *   to the next family." The deadline is the API's; the countdown is a guide.
 * - "Take the place · $60": `POST /v1/waitlist-offers/{id}/accept` (with the offer's
 *   `expectedRevision`) turns the reserved place into a held cart, then Review & pay (1f) with the
 *   place held until the offer ends. A form the activity needs first opens the sign sheet here.
 * - "Pass to the next family" asks first ("Pass on this place? It goes to the next family. Maya
 *   stays on the waitlist for later places."), then `POST .../decline`.
 * - At the deadline the screen becomes ● "This offer ended at 9:41" with "Stay on the waitlist".
 * - ✕ closes; the offer stays in Inbox and on Home's To do until it ends.
 * Offline: the offer and its clock show; taking and passing need a connection.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useInsets } from '../../../ui/insets';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { artworkFor } from '../../../artwork/artworkFor';
import { useBusyTimes } from '../../../features/register/family-busy';
import {
  firstClash,
  lengthWords,
  meetingPattern,
  shortRange,
  wholeMoney,
} from '../../../features/register/fit';
import { deadlineWords, offerClock } from '../../../features/register/offer-clock';
import { formatMoney } from '../../../features/registration/format';
import { MY_BASKETS_KEY, MY_WAITLIST_KEY } from '../../../features/registration/in-progress';
import { registrationRoutes } from '../../../features/registration/routes';
import { formatTime } from '../../../features/today/time';
import { useConnectivity, useNow } from '../../../providers/AppProviders';
import { LiveRegion, sentences } from '../../../ui/announce';
import { Artwork } from '../../../ui/Artwork';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { CommandError } from '../../../ui/CommandError';
import { IconButton } from '../../../ui/IconButton';
import { MediaScrim } from '../../../ui/MediaCard';
import { Sheet } from '../../../ui/Sheet';
import { StatusBadge } from '../../../ui/StatusBadge';
import { Text } from '../../../ui/Text';
import {
  elevation,
  fonts,
  layout,
  makeStyles,
  radius,
  spacing,
  tabularFigures,
  useTheme,
} from '../../../ui/theme';
import { FormsContent } from '../RequiredFormsScreen';

type WaitlistEntry = Schema<'WaitlistEntry'>;
type WaitlistOffer = Schema<'WaitlistOffer'>;

export const PASS_TITLE = 'Pass on this place?';

export function passMessage(name: string): string {
  return `It goes to the next family. ${name} stays on the waitlist for later places.`;
}

export function OfferView({
  entry,
  offer,
  childName,
  refetch,
}: {
  entry: WaitlistEntry;
  offer: WaitlistOffer;
  childName: string;
  refetch: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const insets = useInsets();
  const offline = useConnectivity().reachable === false;
  // Re-read every second: the minutes tick over and, under an hour, the seconds show.
  const now = useNow(1000);
  const clock = offerClock(offer.expiresAt, now);
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: entry.offeringId } },
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: entry.offeringId } },
  });
  const o = offering.data;
  const zone = o?.facility.timezone ?? 'UTC';
  const busy = useBusyTimes(entry.participantPersonId, zone).busy;
  const live = (sessions.data ?? []).filter((s) => s.status !== 'canceled');
  const clash =
    busy && sessions.data
      ? firstClash(
          live,
          busy.filter((b) => b.offeringId !== entry.offeringId),
        )
      : null;
  const price = o?.price && !o.price.notQuotable ? o.price : null;
  const amount = price ? wholeMoney(price.basePriceMinor, price.currency) : null;
  const [passing, setPassing] = useState(false);
  const [forms, setForms] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const invalidate = [['api', '/waitlist-entries/{id}'], MY_WAITLIST_KEY] as const;
  const accept = useApiCommand('post', '/waitlist-offers/{id}/accept', {
    invalidate: [...invalidate, MY_BASKETS_KEY],
  });
  const decline = useApiCommand('post', '/waitlist-offers/{id}/decline', { invalidate });
  const ended = clock.ended || offer.status !== 'offered';

  const take = async () => {
    setFailure(null);
    try {
      const result = await accept.submit({
        path: { id: offer.id },
        body: { expectedRevision: offer.revision },
      });
      if (result.basket) router.push(registrationRoutes.offerReview(result.basket.id));
      else refetch();
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.code === 'MISSING_ACKNOWLEDGMENT') setForms(true);
      else setFailure(apiError);
      if (apiError.code === 'INVALID_TRANSITION' || apiError.code === 'STALE_REVISION') refetch();
    }
  };
  const pass = async () => {
    setFailure(null);
    try {
      await decline.submit({ path: { id: offer.id }, body: { expectedRevision: offer.revision } });
      setPassing(false);
      refetch();
    } catch (error) {
      setPassing(false);
      setFailure(error as ApiError);
    }
  };
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const when = [
    sessions.data ? meetingPattern(sessions.data, zone) : null,
    o ? shortRange(o.startsOn, o.endsOn) : null,
    o?.locationLabel,
  ]
    .filter(Boolean)
    .join(' · ');
  const length = sessions.data ? lengthWords(sessions.data, zone) : null;
  const sessionCount = live.length;

  return (
    <View style={styles.root} testID="waitlist-offer-view">
      <View>
        {o ? (
          <Artwork source={artworkFor(o, 'wide').source} aspectRatio={390 / 330} rounded={false} />
        ) : (
          <View style={styles.heroBlank} />
        )}
        <MediaScrim fadeHeight={120}>
          <View style={styles.tag}>
            <Text style={styles.tagText}>{`A place opened for ${childName}`}</Text>
          </View>
          <Text variant="title1" tone="onMedia" heading>
            {o?.name ?? 'Your waitlist place'}
          </Text>
          {when ? (
            <Text variant="callout" tone="onMediaMuted">
              {when}
            </Text>
          ) : null}
        </MediaScrim>
        <View style={[styles.close, { top: insets.top + spacing.sm }]}>
          <IconButton
            icon="close"
            label="Close"
            variant="onMedia"
            onPress={close}
            testID="offer-close"
          />
        </View>
      </View>
      <View style={styles.body}>
        {ended ? (
          <LiveRegion
            announcement={sentences(
              `This offer ended at ${formatTime(offer.expiredAt ?? offer.declinedAt ?? offer.expiresAt, zone)}`,
              `${childName} stays on the waitlist.`,
            )}
            occurrence={offer.id}
            style={[styles.clock, elevation(theme, 'raised')]}
            testID="offer-ended"
          >
            <StatusBadge
              tone="neutral"
              label={
                offer.status === 'declined'
                  ? 'You passed this place to the next family'
                  : offer.status === 'accepted'
                    ? 'You took this place'
                    : `This offer ended at ${formatTime(offer.expiredAt ?? offer.expiresAt, zone)}`
              }
            />
            <Text variant="footnote" tone="muted" style={styles.center}>
              {offer.status === 'accepted'
                ? 'Finish paying from your registration.'
                : `${childName} stays on the waitlist for later places.`}
            </Text>
          </LiveRegion>
        ) : (
          <View
            style={[styles.clock, elevation(theme, 'raised')]}
            accessible
            accessibilityLabel={`The offer ends in ${clock.spoken}. Until ${deadlineWords(offer.expiresAt, now, zone)}. After that it goes to the next family.`}
            testID="offer-clock"
          >
            <Text variant="label" tone="muted">
              The offer ends in
            </Text>
            <View style={styles.tiles}>
              {clock.tiles.map(([value, unit]) => (
                <View key={unit} style={styles.tile}>
                  <Text style={styles.tileValue}>{value}</Text>
                  <Text style={styles.tileUnit}>{unit}</Text>
                </View>
              ))}
            </View>
            <Text variant="footnote" tone="muted" style={styles.center}>
              {`Until ${deadlineWords(offer.expiresAt, now, zone)}. After that it goes to the next family.`}
            </Text>
          </View>
        )}
        {!ended ? (
          <Card style={styles.facts}>
            <View style={styles.factRow}>
              <Text variant="callout">
                {sessionCount > 0
                  ? `${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`
                  : (length ?? 'Price')}
              </Text>
              {price ? (
                <Text variant="callout" tabular>
                  {formatMoney(price.basePriceMinor, price.currency)}
                </Text>
              ) : null}
            </View>
            {busy && sessions.data ? (
              <View style={[styles.factRow, styles.divider]}>
                <StatusBadge
                  tone={clash ? 'warning' : 'success'}
                  label={
                    clash ? `Clashes with ${clash.title}` : `No clash with ${childName}'s calendar`
                  }
                />
              </View>
            ) : null}
          </Card>
        ) : null}
        <CommandError
          wording="registration"
          error={failure}
          onRetry={() => void take()}
          onReload={refetch}
        />
      </View>
      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {ended ? (
          <Button
            label="Stay on the waitlist"
            size="lg"
            block
            onPress={close}
            testID="offer-stay"
          />
        ) : (
          <>
            <Button
              label={amount ? `Take the place · ${amount}` : 'Take the place'}
              size="lg"
              block
              busy={accept.isProcessing}
              disabled={offline}
              onPress={() => void take()}
              accessibilityHint="Holds the place until the offer ends and opens Review and pay"
              testID="offer-take"
            />
            <Button
              label="Pass to the next family"
              variant="text"
              block
              disabled={offline || accept.isProcessing}
              onPress={() => setPassing(true)}
              testID="offer-pass"
            />
            {offline ? (
              <Text variant="footnote" tone="muted" style={styles.center}>
                Taking or passing needs a connection.
              </Text>
            ) : null}
          </>
        )}
      </View>
      <Sheet
        open={passing}
        onClose={() => setPassing(false)}
        title={PASS_TITLE}
        locked={decline.isProcessing}
        testID="offer-pass-confirm"
        footer={
          <View style={styles.confirm}>
            <Button
              label="Pass"
              variant="secondary"
              block
              busy={decline.isProcessing}
              onPress={() => void pass()}
              testID="offer-pass-yes"
            />
            <Button label="Keep it" block onPress={() => setPassing(false)} />
          </View>
        }
      >
        <Text variant="body">{passMessage(childName)}</Text>
      </Sheet>
      <Sheet
        open={forms}
        onClose={() => setForms(false)}
        title="Forms to sign"
        testID="offer-forms"
      >
        <FormsContent source={{ waitlistEntryId: entry.id }} embedded />
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  heroBlank: { height: 330, backgroundColor: colors.night },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.floodlight,
  },
  tagText: { ...fonts.bold, fontSize: 12, lineHeight: 16, color: colors.onFloodlight },
  close: { position: 'absolute', left: spacing.md },
  body: { paddingHorizontal: layout.gutter, paddingTop: 18, gap: 14 },
  clock: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
  },
  tiles: { flexDirection: 'row', gap: spacing.sm },
  tile: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: 14,
    minWidth: 64,
    borderRadius: radius.md,
    backgroundColor: colors.night,
  },
  tileValue: {
    ...fonts.bold,
    ...tabularFigures,
    fontSize: 30,
    lineHeight: 34,
    color: colors.onNight,
  },
  tileUnit: { ...fonts.semibold, fontSize: 11, lineHeight: 14, color: colors.nightMuted },
  center: { textAlign: 'center' },
  facts: { paddingVertical: spacing.xs },
  factRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  footer: {
    marginTop: 'auto',
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  confirm: { gap: spacing.sm },
}));
