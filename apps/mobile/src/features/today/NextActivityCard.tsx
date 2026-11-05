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
import { colors, spacing, type } from '../../ui/theme';
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
  testID?: string;
}

export function whenText(model: Pick<ActivityCardModel, 'start' | 'end' | 'zone'>): string {
  if (!model.start || !model.end) return 'Time not yet scheduled';
  return formatRange(model.start, model.end, model.zone.zone);
}

export function NextActivityCard({
  model,
  rsvp,
  onOpen,
  openLabel = 'View details',
  testID = 'next-activity-card',
}: NextActivityCardProps) {
  const when = whenText(model);
  return (
    <View style={styles.card} testID={testID}>
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
        <Fact label="For" value={model.participant} />
        {model.opponent ? <Fact label="Against" value={model.opponent} /> : null}
        <Fact label="When" value={when} />
        <Fact label="Where" value={model.location ?? 'Place not shown yet'} />
      </View>
      <StatusBadge {...model.status} testID={`${testID}-status`} />
      {model.change ? <ChangeDetails change={model.change} testID={`${testID}-change`} /> : null}
      {model.requiredAction ? (
        <View
          style={styles.action}
          accessible
          accessibilityLabel={`Action needed: ${model.requiredAction}`}
        >
          <StatusBadge tone="warning" label="Action needed" />
          <Text style={styles.body}>{model.requiredAction}</Text>
        </View>
      ) : null}
      {rsvp}
      {onOpen ? <Button label={openLabel} variant="secondary" onPress={onOpen} /> : null}
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Text style={styles.body}>
      <Text style={styles.key}>{label}: </Text>
      {value}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.background,
  },
  title: { ...type.heading, color: colors.text },
  facts: { gap: spacing.xs },
  body: { ...type.body, color: colors.text },
  key: { fontWeight: '700' },
  action: { gap: spacing.xs },
});
