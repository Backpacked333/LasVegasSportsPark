/**
 * SCR-C-04 Next-activity card (SPK-UX-004, SPK-COMMS-005, SPK-SCHED-008, SPK-UX-009): participant,
 * activity or fixture, opponent where relevant, place, start time with its time zone, current
 * status, material changes as old and new details, the required action, and RSVP where relevant.
 * Used on Home (SCR-C-03), Schedule (SCR-C-18) and the activity and fixture detail (SCR-C-20).
 *
 * The status is a StatusBadge phrase from journeys.md section 3, so "Payment processing",
 * "Awaiting placement" and "Confirmed" differ in words and glyph, not only colour. Arrival guidance
 * appears only when configured (POL-046 is pending, so the card shows none). Facility and pitch
 * names are shown only when the API provides them.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../../ui/Button';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { colors, fonts, radius, spacing, type } from '../../ui/theme';
import { ChangeDetails } from './ChangeDetails';
import type { ScheduleChange } from './notices';
import { formatRange, type DisplayZone } from './time';

export interface ActivityCardModel {
  /** "You", a family member's given name, or a neutral label (never more child detail). */
  participant: string;
  /** Activity or fixture name, e.g. the offering name or "Lions vs Tigers". */
  title: string;
  /** The other team, where relevant (fixtures). */
  opponent?: string | null;
  /** Place as the API states it (offering location label, field names from a notice). */
  location?: string | null;
  start: string | null;
  end: string | null;
  zone: DisplayZone;
  status: StatusBadgeProps;
  /** The latest material change, with old and new details (SPK-COMMS-005). */
  change?: ScheduleChange | null;
  /** What the customer must do before taking part, in the API's words. */
  requiredAction?: string | null;
}

export interface NextActivityCardProps {
  model: ActivityCardModel;
  /** RSVP control for fixtures (SPK-CAP-003); omitted for sessions. */
  rsvp?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  /** Floodlight label above the title, e.g. "Next up" on Home and Schedule. */
  eyebrow?: string;
  testID?: string;
}

export function whenText(model: Pick<ActivityCardModel, 'start' | 'end' | 'zone'>): string {
  if (!model.start || !model.end) return 'Time not yet scheduled';
  return formatRange(model.start, model.end, model.zone.zone);
}

/**
 * Look: a night pitch hero (eyebrow, condensed title, the facts, the status pill) over a white
 * body with the change, the required action, the RSVP and the way in, so every control and
 * failure view below keeps the light-surface contrast it was designed for.
 */
export function NextActivityCard({
  model,
  rsvp,
  onOpen,
  openLabel = 'View details',
  eyebrow,
  testID = 'next-activity-card',
}: NextActivityCardProps) {
  const when = whenText(model);
  const hasBody = Boolean(model.change || model.requiredAction || rsvp || onOpen);
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.hero}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title} accessibilityRole="header">
          {model.title}
        </Text>
        <View
          accessible
          accessibilityLabel={[
            `For: ${model.participant}`,
            model.opponent ? `Against: ${model.opponent}` : null,
            `When: ${when}`,
            `Where: ${model.location ?? 'Place not shown yet'}`,
          ]
            .filter(Boolean)
            .join('. ')}
          style={styles.facts}
        >
          <Fact label="When" value={when} strong />
          <Fact label="Where" value={model.location ?? 'Place not shown yet'} strong />
          <Fact label="For" value={model.participant} />
          {model.opponent ? <Fact label="Against" value={model.opponent} /> : null}
        </View>
        <StatusBadge {...model.status} testID={`${testID}-status`} />
      </View>
      {hasBody ? (
        <View style={styles.body}>
          {model.change ? (
            <ChangeDetails change={model.change} testID={`${testID}-change`} />
          ) : null}
          {model.requiredAction ? (
            <View
              style={styles.action}
              accessible
              accessibilityLabel={`Action needed: ${model.requiredAction}`}
            >
              <StatusBadge tone="warning" label="Action needed" />
              <Text style={styles.actionText}>{model.requiredAction}</Text>
            </View>
          ) : null}
          {rsvp}
          {onOpen ? <Button label={openLabel} variant="secondary" onPress={onOpen} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Fact({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <Text style={strong ? styles.factStrong : styles.fact}>
      <Text style={styles.key}>{label}: </Text>
      {value}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.xl,
    overflow: 'hidden',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hero: { backgroundColor: colors.night, padding: spacing.lg, gap: spacing.sm },
  eyebrow: { ...type.eyebrow, color: colors.floodlight },
  title: { ...type.title, fontSize: 30, lineHeight: 32, color: colors.primaryText },
  facts: { gap: 2 },
  fact: { ...type.caption, color: colors.nightText },
  factStrong: { ...type.body, ...fonts.semibold, color: colors.primaryText },
  key: { ...fonts.regular, color: colors.nightMuted },
  body: { padding: spacing.lg, gap: spacing.md },
  action: { gap: spacing.xs },
  actionText: { ...type.body, color: colors.text },
});
