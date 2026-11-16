/**
 * The "Who's going?" step of registering (SCR-C-09; SPK-REG-001, SPK-REG-002, SPK-IAM-003; PA-11,
 * ADR-008 visual system v2):
 *
 * - `PersonCard`: one card per person the account can register, with their initials (`Avatar`),
 *   their name, and the API's eligibility for the chosen registration type inside the card: the
 *   status, the reasons and the permitted alternatives (SPK-REG-002), or why they cannot be
 *   chosen. The whole card is one checkbox (or radio, for one person in one session) for screen
 *   readers, named "Name. Status. Reasons." as the rows before it were (SPK-UX-009).
 * - `RegistrationTypePicker`: the registration type (the API's intents, ENR-05). With more than one
 *   choice it is a field-styled button that opens a `Sheet` of radio cards; with one it is a plain
 *   card that says which type applies, and nothing opens. Choosing closes the sheet and focus goes
 *   back to the button (`Sheet` `returnFocusTo`).
 *
 * Neither decides anything: who may be chosen and which types exist are the API's answers, and
 * the API checks every line again.
 */
import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Avatar } from '../../ui/Avatar';
import { ChoiceCard, useSelectionHaptic } from '../../ui/ChoiceList';
import { useFieldStyles } from '../../ui/Field';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import {
  continuousCorners,
  fonts,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  type,
  useTheme,
} from '../../ui/theme';

/** The words of a person card after the name, as screen readers hear them. */
export function personCardDetail(summary: string | undefined, lines: readonly string[]): string {
  return [summary, ...lines].filter((part): part is string => Boolean(part)).join('. ');
}

export interface PersonCardProps {
  personId: string;
  name: string;
  /** The first line under the name: "Eligible", "Not eligible", "Added to your cart". */
  summary?: string;
  /** The API's reasons and alternatives, one per line. */
  lines?: readonly string[];
  checked: boolean;
  disabled?: boolean;
  /** `checkbox` (several people, the default) or `radio` (one person). */
  mode?: 'checkbox' | 'radio';
  onToggle: () => void;
  testID?: string;
}

export function PersonCard({
  personId,
  name,
  summary,
  lines = [],
  checked,
  disabled = false,
  mode = 'checkbox',
  onToggle,
  testID,
}: PersonCardProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const haptic = useSelectionHaptic();
  const detail = personCardDetail(summary, lines);
  const glyph =
    mode === 'radio'
      ? checked
        ? 'radio_button_checked'
        : 'radio_button_unchecked'
      : checked
        ? 'check_box'
        : 'check_box_outline_blank';
  return (
    <Pressable
      accessibilityRole={mode}
      accessibilityLabel={detail ? `${name}. ${detail}` : name}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => {
        haptic();
        onToggle();
      }}
      style={({ pressed }) => [
        styles.card,
        checked ? styles.checked : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
      testID={testID}
    >
      <Avatar name={name} id={personId} decorative />
      <View style={styles.words}>
        <Text style={styles.name}>{name}</Text>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}
        {lines.map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}
      </View>
      <Icon name={glyph} size={24} color={checked ? colors.primary : colors.textMuted} />
    </Pressable>
  );
}

export interface RegistrationTypeOption<V extends string> {
  value: V;
  label: string;
  /** What the type is, and why it cannot be chosen when it cannot. */
  detail: string;
  disabled: boolean;
}

/** The button's name; the sheet's title. */
export const REGISTRATION_TYPE_LABEL = 'Registration type';

export function RegistrationTypePicker<V extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly RegistrationTypeOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
}) {
  const styles = useStyles();
  const field = useFieldStyles();
  const { colors } = useTheme();
  const haptic = useSelectionHaptic();
  const [open, setOpen] = useState(false);
  const trigger = useRef<View>(null);
  const current = options.find((o) => o.value === value) ?? null;
  const only = options.length === 1 ? options[0] : undefined;

  if (only) {
    // One type: nothing to choose, so it is said, not offered.
    return (
      <View
        style={styles.only}
        accessible
        accessibilityLabel={`${REGISTRATION_TYPE_LABEL}: ${only.label}. ${only.detail}`}
        testID="registration-type"
      >
        <Text style={field.label}>{REGISTRATION_TYPE_LABEL}</Text>
        <Text style={styles.name}>{only.label}</Text>
        <Text style={styles.summary}>{only.detail}</Text>
      </View>
    );
  }

  return (
    <View style={field.field}>
      <Text style={field.label}>{REGISTRATION_TYPE_LABEL}</Text>
      <Pressable
        ref={trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={REGISTRATION_TYPE_LABEL}
        accessibilityValue={{ text: current?.label ?? 'Choose' }}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [field.box, field.boxButton, pressed ? field.pressed : null]}
        testID="registration-type"
      >
        <Text style={current ? field.value : field.placeholder}>{current?.label ?? 'Choose'}</Text>
        <Icon name="expand_more" size={22} color={colors.textMuted} />
      </Pressable>
      {current ? <Text style={field.hint}>{current.detail}</Text> : null}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={REGISTRATION_TYPE_LABEL}
        returnFocusTo={trigger}
      >
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={REGISTRATION_TYPE_LABEL}
          style={{ gap: spacing.sm }}
        >
          {options.map((option) => (
            <ChoiceCard
              key={option.value}
              option={{ value: option.value, label: option.label, description: option.detail }}
              mode="single"
              checked={option.value === value}
              disabled={option.disabled}
              accessibilityLabel={`${option.label}. ${option.detail}`}
              onPress={() => {
                setOpen(false);
                if (option.value === value) return;
                haptic();
                onChange(option.value);
              }}
              testID={`intent-${option.value}`}
            />
          ))}
        </View>
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
  },
  checked: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.tonal },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.6 },
  words: { flex: 1, gap: spacing.xxs },
  name: { ...type.heading, color: colors.text },
  summary: { ...type.callout, ...fonts.semibold, color: colors.textMuted },
  line: { ...type.footnote, color: colors.textMuted },
  only: { gap: spacing.xxs },
}));
