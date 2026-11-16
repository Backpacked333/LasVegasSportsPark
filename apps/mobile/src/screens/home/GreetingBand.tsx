/**
 * The top of SCR-C-03 Home (ADR-008): the day and a large greeting with the person's given name
 * from `GET /v1/me` ("Hi, Alex"; "Home" before the name is known or signed out), over the day or
 * the night band. The band follows the hour on the facility's clock (SPK-SCHED-008): the zone the
 * family calendar states for its activities (the same read Home makes, so no extra request), else
 * the device's zone. The time comes from the injected clock (`useNow`), never the system clock.
 *
 * The band is decorative (`Artwork`); the greeting is the page's header for screen readers. Words
 * sit on the scrim token over the picture; at large text sizes they move below it, as on
 * `MediaCard`. The cart, pass and inbox actions are in the tab header above (`HeaderActions`).
 */
import { useWindowDimensions, View } from 'react-native';
import { homeBandFor } from '../../artwork/artworkFor';
import { SCHEDULE_WINDOW_DAYS, useCalendarWindow, useMe } from '../../features/today/queries';
import { displayZone, formatDay, localHour, zoneOf } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { Artwork } from '../../ui/Artwork';
import { mediaTextPlacement } from '../../ui/MediaCard';
import { Text } from '../../ui/Text';
import { continuousCorners, layout, makeStyles, radius, spacing } from '../../ui/theme';

/** The band's picture: 21:9, as the artwork is drawn. */
const BAND_ASPECT = 21 / 9;

export function GreetingBand() {
  const styles = useStyles();
  const now = useNow();
  const me = useMe();
  const { fontScale } = useWindowDimensions();
  // Same key as Home's next-activity read (device zone window), so this is a cache hit.
  const calendar = useCalendarWindow(now, SCHEDULE_WINDOW_DAYS, displayZone(null).zone);
  const zone = zoneOf(...(calendar.data?.items ?? []).map((item) => item.timezone)).zone;
  const band = homeBandFor(localHour(now, zone));
  const given = me.data?.person?.givenName?.trim();
  const over = mediaTextPlacement(fontScale) === 'over';
  const words = (
    <View style={styles.words}>
      <Text variant="footnote" tone={over ? 'onMediaMuted' : 'muted'}>
        {formatDay(now, zone)}
      </Text>
      <Text variant="largeTitle" tone={over ? 'onMedia' : 'default'} heading>
        {given ? `Hi, ${given}` : 'Home'}
      </Text>
    </View>
  );
  return (
    <View style={styles.root} testID="home-greeting">
      <View style={styles.frame}>
        <Artwork
          source={band.source}
          aspectRatio={BAND_ASPECT}
          rounded={false}
          testID={`home-band-${band.band}`}
        />
        {over ? <View style={styles.scrim}>{words}</View> : null}
      </View>
      {over ? null : <View style={styles.below}>{words}</View>}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { paddingHorizontal: layout.gutter, paddingTop: spacing.xs },
  frame: { borderRadius: radius.xl, ...continuousCorners, overflow: 'hidden' },
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrimEnd,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  below: { paddingTop: spacing.sm },
  words: { gap: spacing.xxs },
}));
