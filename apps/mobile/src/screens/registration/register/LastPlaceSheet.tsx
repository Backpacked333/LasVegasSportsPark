/**
 * Register · the last place went during payment (redesign handoff M 4e; SPK-AT-005): "You weren't
 * charged" comes first, then the choices with prices already worked out again (`last-place.ts`),
 * the best one pre-selected, and any discount that drops out explained. One tap joins the
 * waitlist. The words are announced when the sheet opens (SPK-UX-009).
 */
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { LastPlaceChoice, LastPlaceModel } from '../../../features/register/last-place';
import { LiveRegion, sentences } from '../../../ui/announce';
import { Button } from '../../../ui/Button';
import { Icon } from '../../../ui/Icon';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { fonts, makeStyles, radius, spacing, useTheme } from '../../../ui/theme';

export const NOT_CHARGED_LINE = "You weren't charged.";

export function LastPlaceSheet({
  open,
  model,
  busy,
  onChoose,
  onClose,
}: {
  open: boolean;
  model: LastPlaceModel | null;
  busy: boolean;
  onChoose: (choice: LastPlaceChoice) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { colors, toneBackgrounds } = useTheme();
  const [choice, setChoice] = useState<LastPlaceChoice | null>(model?.best ?? null);
  useEffect(() => {
    if (open) setChoice(model?.best ?? null);
  }, [open, model?.best]);
  if (!model) return null;
  const chosen = choice ?? model.best;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={model.title}
      locked={busy}
      testID="last-place-sheet"
    >
      <LiveRegion
        announcement={sentences(
          model.title,
          'Another family took the last place while you were paying.',
          NOT_CHARGED_LINE,
        )}
        occurrence={model.title}
        style={styles.head}
      >
        <View style={[styles.icon, { backgroundColor: toneBackgrounds.warning }]}>
          <Icon name="hourglass_top" size={32} color={colors.warning} />
        </View>
        <Text variant="body" style={styles.center}>
          Another family took the last place while you were paying.{' '}
          <Text variant="body" style={styles.bold}>
            {NOT_CHARGED_LINE}
          </Text>
        </Text>
      </LiveRegion>
      <View
        style={styles.options}
        accessibilityRole="radiogroup"
        accessibilityLabel="What to do now"
      >
        {model.options.map((option, i) => {
          const on = chosen === option.value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${option.label}. ${option.detail}`}
              onPress={() => setChoice(option.value)}
              style={[styles.option, i > 0 ? styles.divider : null]}
              testID={`last-place-${option.value}`}
            >
              <View style={[styles.radio, on ? styles.radioOn : null]}>
                {on ? <View style={styles.dot} /> : null}
              </View>
              <View style={styles.words}>
                <Text variant="callout" style={styles.bold}>
                  {option.label}
                </Text>
                <Text variant="footnote" tone="muted">
                  {option.detail}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {model.droppedNote ? (
        <Text variant="footnote" tone="muted" style={styles.center} testID="last-place-dropped">
          {model.droppedNote}
        </Text>
      ) : null}
      <Button
        label={model.actionOf(chosen)}
        size="lg"
        block
        busy={busy}
        onPress={() => onChoose(chosen)}
        testID="last-place-go"
      />
    </Sheet>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  head: { alignItems: 'center', gap: 10, paddingTop: spacing.sm },
  icon: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { textAlign: 'center' },
  bold: { ...fonts.semibold },
  options: {
    backgroundColor: colors.page,
    borderRadius: 18,
    paddingHorizontal: 14,
    marginTop: spacing.md,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    minHeight: 56,
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: colors.primary },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary },
  words: { flex: 1, gap: 2 },
}));
