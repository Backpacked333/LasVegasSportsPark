/**
 * Register 1/3 · Who (redesign handoff M 1e; INTERACTIONS "1e–1g" rows 1 and 2; SPK-REG-002,
 * SPK-IAM-003): a sheet over the activity, so the parent never loses track of what they are
 * buying. One row per person the account may register, with the API's eligibility in plain words
 * (`eligibility-words.ts`): "✓ Age 8 · can join", or greyed with the reason and the activity the
 * API suggests instead ("Ages 7 to 9. Leo is 5. Try Little Kickers."). Someone already holding a
 * place reads "✓ Already in" and cannot be ticked. "Someone else" opens the family to add a child.
 * Continue names who is going and is disabled until someone is ticked.
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { useInsets } from '../../../ui/insets';
import { artworkFor } from '../../../artwork/artworkFor';
import { useHousehold } from '../../../features/home/household';
import type { WhoRow } from '../../../features/register/who';
import type { RegistrationIntent } from '../../../features/registration/format';
import { INTENT_LABELS } from '../../../features/registration/intents';
import { useApiRecords } from '../../../features/registration/queries';
import { Artwork } from '../../../ui/Artwork';
import { Avatar } from '../../../ui/Avatar';
import { Button } from '../../../ui/Button';
import { Chip, ChipRow } from '../../../ui/Chip';
import { Icon } from '../../../ui/Icon';
import { IconButton } from '../../../ui/IconButton';
import { personColorOf } from '../../../ui/person-colors';
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
import { StepBar } from './StepChrome';

type Offering = Schema<'Offering'>;

/** "Maya", "Maya and Leo", "Maya, Leo and Ava". */
export function namesList(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function WhoStep({
  offering,
  subtitle,
  fromPrice,
  rows,
  selected,
  onToggle,
  intents,
  intent,
  onIntent,
  loading,
  onContinue,
  onClose,
  problem,
}: {
  offering: Offering;
  /** "Saturdays from Mar 7 · 10 weeks". */
  subtitle: string;
  /** "$120". */
  fromPrice: string | null;
  rows: readonly WhoRow[];
  selected: readonly string[];
  onToggle: (personId: string) => void;
  /** The basket intents the activity takes (a picker when more than one). */
  intents: readonly RegistrationIntent[];
  intent: RegistrationIntent | null;
  onIntent: (intent: RegistrationIntent) => void;
  loading: boolean;
  onContinue: () => void;
  onClose: () => void;
  problem?: React.ReactNode;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const insets = useInsets();
  const { people } = useHousehold();
  const alternatives = useApiRecords(
    '/offerings/{id}',
    rows.map((r) => r.alternativeOfferingId).filter((id): id is string => id !== null),
  );
  const chosen = rows.filter((r) => selected.includes(r.personId) && r.tickable);
  const label =
    chosen.length === 0 ? 'Continue' : `Continue with ${namesList(chosen.map((r) => r.name))}`;
  return (
    <View style={styles.root} testID="register-who">
      <Artwork
        source={artworkFor(offering, 'wide').source}
        aspectRatio={390 / 300}
        rounded={false}
      />
      <View style={styles.behind}>
        <Text variant="title1">{offering.name}</Text>
        <Text variant="callout" tone="muted">
          {subtitle}
        </Text>
      </View>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
        testID="register-who-backdrop"
      />
      <View style={[styles.close, { top: insets.top + spacing.sm }]}>
        <IconButton icon="close" label="Close" variant="onMedia" onPress={onClose} />
      </View>
      <View style={[styles.sheet, elevation(theme, 'sheet')]}>
        <View style={styles.grabber} />
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          <StepBar step="Who" />
          <View style={styles.heading}>
            <Text variant="title1" heading>
              Who&apos;s playing?
            </Text>
            <Text variant="label" tone="muted">
              Step 1 of 3
            </Text>
          </View>
          {intents.length > 1 ? (
            <ChipRow label="Registration type" inset={0}>
              {intents.map((option) => (
                <Chip
                  key={option}
                  label={INTENT_LABELS[option].title}
                  selected={intent === option}
                  onPress={() => onIntent(option)}
                />
              ))}
            </ChipRow>
          ) : null}
          {loading ? (
            <Text variant="callout" tone="muted" testID="register-who-loading">
              Checking who can join…
            </Text>
          ) : null}
          <View style={styles.rows} accessibilityRole="list">
            {rows.map((row) => {
              const on = selected.includes(row.personId) && row.tickable;
              const person = people.find((p) => p.id === row.personId);
              const alternative = row.alternativeOfferingId
                ? alternatives[row.alternativeOfferingId]?.data?.name
                : undefined;
              const words = [
                row.badge?.label,
                row.reason,
                alternative ? `Try ${alternative}.` : null,
              ]
                .filter(Boolean)
                .join('. ');
              return (
                <Pressable
                  key={row.personId}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: !row.tickable }}
                  accessibilityLabel={`${row.name}. ${words}`}
                  disabled={!row.tickable}
                  onPress={() => onToggle(row.personId)}
                  style={[styles.row, on ? styles.rowOn : null]}
                  testID={`who-${row.personId}`}
                >
                  <Avatar
                    name={row.name}
                    id={row.personId}
                    personColor={person ? personColorOf(theme, person.slot) : undefined}
                    size={44}
                    decorative
                  />
                  <View style={styles.rowWords}>
                    <Text style={[styles.name, row.tickable ? null : styles.muted]}>
                      {row.name}
                    </Text>
                    {row.badge ? <StatusBadge {...row.badge} /> : null}
                    {row.reason && !row.tickable ? (
                      <Text variant="footnote" tone="muted">
                        {row.reason}
                        {alternative ? (
                          <>
                            {' Try '}
                            <Text
                              variant="footnote"
                              style={styles.link}
                              onPress={() =>
                                router.push(`/registration/offering/${row.alternativeOfferingId}`)
                              }
                              accessibilityRole="link"
                            >
                              {alternative}
                            </Text>
                            .
                          </>
                        ) : null}
                      </Text>
                    ) : null}
                    {row.reason && row.tickable ? (
                      <Text variant="footnote" tone="muted">
                        {row.reason}
                      </Text>
                    ) : null}
                  </View>
                  {row.tickable ? (
                    <View style={[styles.tick, on ? styles.tickOn : null]}>
                      {on ? <Icon name="check" size={18} color={theme.colors.primaryText} /> : null}
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Someone else"
              accessibilityHint="Opens your family, where you can add a child"
              onPress={() => router.push('/family')}
              style={styles.someone}
              testID="who-someone-else"
            >
              <Icon name="person_add" size={22} color={theme.colors.primary} />
              <Text style={styles.someoneLabel}>Someone else</Text>
            </Pressable>
          </View>
          {problem}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          {fromPrice ? (
            <View accessible accessibilityLabel={`From ${fromPrice}`}>
              <Text variant="footnote" tone="muted">
                From
              </Text>
              <Text style={styles.price}>{fromPrice}</Text>
            </View>
          ) : null}
          <View style={styles.cta}>
            <Button
              label={label}
              size="lg"
              block
              disabled={chosen.length === 0}
              onPress={onContinue}
              testID="who-continue"
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  behind: { padding: spacing.lg, paddingHorizontal: layout.gutter, gap: 6 },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.backdrop,
  },
  close: { position: 'absolute', left: spacing.md },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '78%',
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 9,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.control,
  },
  content: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm, gap: spacing.md },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rows: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  rowOn: {
    borderWidth: 2,
    padding: 13,
    borderColor: colors.primary,
    backgroundColor: colors.selectedSurface,
  },
  rowWords: { flex: 1, gap: 3 },
  name: { ...fonts.bold, fontSize: 17, lineHeight: 22, color: colors.text },
  muted: { color: colors.textMuted },
  link: { ...fonts.semibold, color: colors.primary },
  tick: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  someone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: 14,
    minHeight: 56,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.control,
  },
  someoneLabel: { ...fonts.semibold, fontSize: 15, color: colors.primary },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    paddingHorizontal: layout.gutter,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  price: { ...fonts.bold, ...tabularFigures, fontSize: 19, color: colors.text },
  cta: { flex: 1 },
}));
