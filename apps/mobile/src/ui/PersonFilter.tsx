/**
 * The household "who" filter (redesign handoff INTERACTIONS Shell row 5, Phase 0; ADR-008 visual
 * system v2, **Proposed**): chips "Everyone" and one per person, which filter a whole page to that
 * person. Home uses it now; Calendar and Explore are meant to share it ("Calendar" on Home switches
 * tab with the same filter), so the choice lives above the screens:
 *
 * - `PersonFilterProvider` (in `AppProviders`) holds the choice for the whole app and remembers it
 *   on the device (`services.personFilterStore`, a person id or nothing).
 * - `usePersonFilter(people)` reads it for the people a screen shows: a remembered person who is
 *   not among them (another account signed in, a member removed) reads as "Everyone" (`null`).
 * - `PersonChipRow` draws the chips: "Everyone" first, then each person with their avatar in their
 *   household colour (`src/ui/person-colors.ts`). The selected chip is night-filled. With one
 *   person the row is not drawn (nothing to choose); with five or more chips it scrolls sideways.
 *
 * Accessibility (SPK-UX-009): the row is a radio group named by `label`; each chip is a radio with
 * the person's name, its checked state read out, and a 44 pt touch target around the 36 pt chip.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, type StyleProp, type ViewStyle } from 'react-native';
import { Avatar } from './Avatar';
import { useSelectionHaptic } from './ChoiceList';
import { Icon } from './Icon';
import { MemoryPersonFilterStore, type PersonFilterStore } from './person-filter-store';
import { fonts, layout, makeStyles, radius, spacing, useTheme, type PersonColor } from './theme';

export interface FilterPerson {
  id: string;
  /** The words on the chip ("Maya", "Me"). */
  label: string;
  /** The full name read by screen readers when it differs from the label. */
  accessibilityLabel?: string;
  color: PersonColor;
  photoUri?: string | null;
}

interface FilterContextValue {
  value: string | null;
  set(personId: string | null): void;
}

const FilterContext = createContext<FilterContextValue | null>(null);

export function PersonFilterProvider({
  store,
  children,
}: {
  store?: PersonFilterStore;
  children: ReactNode;
}) {
  const backing = useMemo(() => store ?? new MemoryPersonFilterStore(), [store]);
  const [value, setValue] = useState<string | null>(() => backing.read());
  const set = useCallback(
    (personId: string | null) => {
      setValue(personId);
      backing.write(personId);
    },
    [backing],
  );
  const context = useMemo(() => ({ value, set }), [value, set]);
  return <FilterContext.Provider value={context}>{children}</FilterContext.Provider>;
}

export interface PersonFilterState {
  /** The person chosen, or null for "Everyone". */
  selected: string | null;
  select(personId: string | null): void;
}

/**
 * The filter for the people a screen shows. Without a provider (a component on its own in a test)
 * the choice is local to the component.
 */
export function usePersonFilter(people: readonly { id: string }[]): PersonFilterState {
  const shared = useContext(FilterContext);
  const [local, setLocal] = useState<string | null>(null);
  const value = shared ? shared.value : local;
  const set = shared ? shared.set : setLocal;
  const selected = value && people.some((p) => p.id === value) ? value : null;
  return { selected, select: set };
}

export interface PersonChipRowProps {
  people: readonly FilterPerson[];
  selected: string | null;
  onSelect: (personId: string | null) => void;
  /** The group's name for screen readers. */
  label?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PersonChipRow({
  people,
  selected,
  onSelect,
  label = 'Show activities for',
  style,
  testID = 'person-filter',
}: PersonChipRowProps) {
  const styles = useStyles();
  if (people.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={style}
      contentContainerStyle={styles.row}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      testID={testID}
    >
      <PersonChip
        label="Everyone"
        icon="family_restroom"
        selected={selected === null}
        onPress={() => onSelect(null)}
        testID={`${testID}-everyone`}
      />
      {people.map((person) => (
        <PersonChip
          key={person.id}
          label={person.label}
          accessibilityLabel={person.accessibilityLabel}
          person={person}
          selected={selected === person.id}
          onPress={() => onSelect(person.id)}
          testID={`${testID}-${person.id}`}
        />
      ))}
    </ScrollView>
  );
}

function PersonChip({
  label,
  accessibilityLabel,
  icon,
  person,
  selected,
  onPress,
  testID,
}: {
  label: string;
  accessibilityLabel?: string;
  icon?: string;
  person?: FilterPerson;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const haptic = useSelectionHaptic();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ checked: selected, selected }}
      hitSlop={{ top: 4, bottom: 4 }}
      onPress={() => {
        if (selected) return;
        haptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        person ? styles.withAvatar : null,
        selected ? styles.selected : styles.unselected,
        pressed && !selected ? styles.pressed : null,
      ]}
      testID={testID}
    >
      {person ? (
        <Avatar
          name={person.accessibilityLabel ?? person.label}
          id={person.id}
          personColor={person.color}
          photoUri={person.photoUri}
          size={28}
          decorative
        />
      ) : icon ? (
        <Icon name={icon} size={18} color={selected ? colors.chipSelectedIcon : colors.textMuted} />
      ) : null}
      <Text style={[styles.label, selected ? styles.selectedLabel : null]}>{label}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  row: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: layout.gutter },
  chip: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  withAvatar: { paddingLeft: spacing.xs, gap: spacing.sm },
  selected: { backgroundColor: colors.chipSelected, borderColor: colors.chipSelected },
  unselected: { backgroundColor: colors.background, borderColor: colors.control },
  pressed: { opacity: 0.7 },
  label: { ...fonts.semibold, fontSize: 14, lineHeight: 18, color: colors.text },
  selectedLabel: { color: colors.onChipSelected },
}));

/** A sentence for screen readers and captions: "Everyone" or the person's label. */
export function filterLabel(people: readonly FilterPerson[], selected: string | null): string {
  if (!selected) return 'Everyone';
  return people.find((p) => p.id === selected)?.label ?? 'Everyone';
}
