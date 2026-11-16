/**
 * SCR-C-04 / SCR-C-18 / SCR-C-20 material changes (SPK-COMMS-005 "Schedule messages must show old
 * and new practical details", SPK-SCHED-007 "Show exactly which events change"): "Was" and "Now"
 * lines in the facility's own time zone from the notice, worded rather than coloured
 * (SPK-UX-009). One focusable element reads the whole change.
 */
import { Text, View } from 'react-native';
import { StatusBadge } from '../../ui/StatusBadge';
import { fonts, makeStyles, radius, spacing, type, useTheme } from '../../ui/theme';
import type { EventDetailsView, ScheduleChange } from './notices';
import { formatRange } from './time';

export function describeDetails(details: EventDetailsView): string {
  const where = details.resources.map((r) => r.name).join(', ');
  const when = formatRange(details.scheduledStart, details.scheduledEnd, details.timezone);
  return where ? `${when} at ${where}` : when;
}

export function changeSummary(change: ScheduleChange): { was: string | null; now: string } {
  const was = change.before ? describeDetails(change.before) : null;
  if (change.kind === 'canceled') return { was, now: 'Canceled' };
  return { was, now: change.after ? describeDetails(change.after) : 'Details not available' };
}

export function ChangeDetails({ change, testID }: { change: ScheduleChange; testID?: string }) {
  const { toneBackgrounds } = useTheme();
  const styles = useStyles();
  const { was, now } = changeSummary(change);
  const badge =
    change.kind === 'canceled'
      ? { tone: 'danger' as const, label: 'Canceled' }
      : change.kind === 'published'
        ? { tone: 'info' as const, label: 'Published' }
        : { tone: 'warning' as const, label: 'Changed' };
  const label = [badge.label, was ? `Was: ${was}` : null, `Now: ${now}`].filter(Boolean).join('. ');
  return (
    <View
      style={[styles.box, { backgroundColor: toneBackgrounds[badge.tone] }]}
      accessible
      accessibilityLabel={label}
      testID={testID}
    >
      <StatusBadge tone={badge.tone} label={badge.label} />
      {was ? (
        <Text style={styles.line}>
          <Text style={styles.key}>Was: </Text>
          {was}
        </Text>
      ) : null}
      <Text style={styles.line}>
        <Text style={styles.key}>Now: </Text>
        {now}
      </Text>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: {
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    borderRadius: radius.md,
  },
  line: { ...type.caption, color: colors.text },
  key: { ...fonts.bold },
}));
