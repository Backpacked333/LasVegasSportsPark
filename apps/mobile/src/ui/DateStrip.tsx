/**
 * DateStrip (ADR-008, **Proposed** visual system v2): a week of day buttons for picking a day in a
 * schedule, with previous week, next week and "Today".
 *
 * - Each day shows a short label ("Tue" over "18") and is named in full for screen readers
 *   ("Tuesday 18 November"), with ", today" and the `markedLabel` ("has activities") when they
 *   apply (SPK-UX-009). The selected day is `selected` and filled; a day with items has a dot, and
 *   its name says so, so neither rests on colour or the dot alone.
 * - Today comes from the `today` prop (the injected clock, `useNow()` or `services.now()`), read in
 *   the facility's time zone when one is given (SPK-SCHED-008, `features/today/time`), else on the
 *   device's clock. Nothing here reads the system clock.
 * - Moving to another week slides the days in from that side, unless motion is reduced
 *   (`useMotion()`; reduced without a `MotionProvider`), when they change in place.
 * - A new day plays the selection haptic.
 *
 * Values are ISO calendar dates (`2026-11-18`). Every button is at least 44 pt.
 */
import { useEffect, useState } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { displayZone, localDayKey } from '../features/today/time';
import { useSelectionHaptic } from './ChoiceList';
import { addIsoDays, fullDateName, isIsoDate, isoWeekday, MONTHS, WEEKDAYS } from './DateField';
import { Icon } from './Icon';
import { useMotion } from './motion';
import {
  fonts,
  makeStyles,
  MIN_TOUCH_SIZE,
  motionTokens,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from './theme';

/** How far the days travel when the week changes (pt). */
const SLIDE_DISTANCE = 32;

/** Today's ISO date: `today` itself when it is a date, else its day in the zone (SPK-SCHED-008). */
export function todayIn(today: Date | string, timeZone?: string | null): string {
  if (typeof today === 'string' && isIsoDate(today)) return today;
  return localDayKey(
    typeof today === 'string' ? new Date(today) : today,
    displayZone(timeZone).zone,
  );
}

/** The first day of the week holding `iso`; `firstDayOfWeek` 0 is Sunday, 1 Monday. */
export function weekStartOf(iso: string, firstDayOfWeek: 0 | 1 = 0): string {
  const back = (isoWeekday(iso) - firstDayOfWeek + 7) % 7;
  return addIsoDays(iso, -back);
}

/** "November 2026", or "November to December 2026" for a week across two months. */
export function weekTitle(start: string): string {
  const end = addIsoDays(start, 6);
  const [sy, sm] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  const month = (m: number) => MONTHS[m - 1] ?? '';
  if (sy !== ey) return `${month(sm)} ${sy} to ${month(em)} ${ey}`;
  if (sm !== em) return `${month(sm)} to ${month(em)} ${sy}`;
  return `${month(sm)} ${sy}`;
}

export interface DateStripProps {
  /** The selected day (`YYYY-MM-DD`). */
  value: string;
  onChange: (value: string) => void;
  /** Now, from the injected clock (`useNow()`), or today's ISO date. */
  today: Date | string;
  /** The facility's IANA zone, for which day "today" is; the device's when absent. */
  timeZone?: string | null;
  /** Days with something on them: a dot, and `markedLabel` in their names. */
  markedDates?: readonly string[];
  markedLabel?: string;
  /** 0 starts weeks on Sunday (the default), 1 on Monday. */
  firstDayOfWeek?: 0 | 1;
  /** The shown week changed (to fetch its items): its first day. */
  onWeekChange?: (weekStart: string) => void;
  /** The strip's accessible name. */
  label?: string;
  previousLabel?: string;
  nextLabel?: string;
  todayLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function DateStrip({
  value,
  onChange,
  today,
  timeZone,
  markedDates = [],
  markedLabel = 'has activities',
  firstDayOfWeek = 0,
  onWeekChange,
  label = 'Choose a day',
  previousLabel = 'Previous week',
  nextLabel = 'Next week',
  todayLabel = 'Today',
  style,
  testID,
}: DateStripProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const motion = useMotion();
  const haptic = useSelectionHaptic();
  const todayIso = todayIn(today, timeZone);

  const [start, setStart] = useState(() => weekStartOf(value, firstDayOfWeek));
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  // A selected day outside the shown week (set from above) brings its week into view.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    const target = weekStartOf(value, firstDayOfWeek);
    if (target !== start) {
      setDirection(target > start ? 1 : -1);
      setStart(target);
    }
  }

  const showWeek = (next: string) => {
    if (next === start) return;
    setDirection(next > start ? 1 : -1);
    setStart(next);
    onWeekChange?.(next);
  };

  const offset = useSharedValue(0);
  const duration = motion.duration('base');
  useEffect(() => {
    if (direction === 0 || motion.reduced) {
      offset.value = 0;
      return;
    }
    offset.value = direction * SLIDE_DISTANCE;
    offset.value = withTiming(0, {
      duration,
      easing: Easing.bezier(...motionTokens.easings.standard),
    });
  }, [start, direction, duration, motion.reduced, offset]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  const marked = new Set(markedDates);
  const days = Array.from({ length: 7 }, (_, i) => addIsoDays(start, i));

  const pick = (day: string) => {
    if (day === value) return;
    haptic();
    onChange(day);
  };

  return (
    <View style={[styles.strip, style]} testID={testID}>
      <View style={styles.header}>
        <Text style={styles.month} accessibilityRole="header">
          {weekTitle(start)}
        </Text>
        <Pressable
          onPress={() => {
            showWeek(weekStartOf(todayIso, firstDayOfWeek));
            pick(todayIso);
          }}
          accessibilityRole="button"
          accessibilityLabel={todayLabel}
          style={({ pressed }) => [styles.todayButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.todayText}>{todayLabel}</Text>
        </Pressable>
        <Pressable
          onPress={() => showWeek(addIsoDays(start, -7))}
          accessibilityRole="button"
          accessibilityLabel={previousLabel}
          style={({ pressed }) => [styles.arrow, pressed ? styles.pressed : null]}
        >
          <Icon name="chevron_left" size={24} color={colors.text} />
        </Pressable>
        <Pressable
          onPress={() => showWeek(addIsoDays(start, 7))}
          accessibilityRole="button"
          accessibilityLabel={nextLabel}
          style={({ pressed }) => [styles.arrow, pressed ? styles.pressed : null]}
        >
          <Icon name="chevron_right" size={24} color={colors.text} />
        </Pressable>
      </View>
      <Animated.View
        style={[styles.days, slide]}
        accessibilityLabel={label}
        testID={testID ? `${testID}-days` : 'date-strip-days'}
      >
        {days.map((day) => {
          const selected = day === value;
          const isToday = day === todayIso;
          const hasItems = marked.has(day);
          const name = [
            fullDateName(day, false),
            isToday ? 'today' : null,
            hasItems ? markedLabel : null,
          ]
            .filter(Boolean)
            .join(', ');
          const weekday = WEEKDAYS[isoWeekday(day)] ?? '';
          return (
            <Pressable
              key={day}
              onPress={() => pick(day)}
              accessibilityRole="button"
              accessibilityLabel={name}
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.day,
                isToday && !selected ? styles.today : null,
                selected ? styles.selected : null,
                pressed && !selected ? styles.pressed : null,
              ]}
            >
              <Text style={[styles.weekday, selected ? styles.onSelected : null]}>
                {weekday.slice(0, 3)}
              </Text>
              <Text style={[styles.date, selected ? styles.onSelected : null]}>
                {Number(day.slice(8, 10))}
              </Text>
              <View
                style={[
                  styles.dot,
                  hasItems ? (selected ? styles.dotOnSelected : styles.dotOn) : null,
                ]}
              />
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  strip: { gap: spacing.sm, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  month: { ...type.heading, color: colors.text, flex: 1 },
  todayButton: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  todayText: { ...type.callout, ...fonts.semibold, color: colors.primary },
  arrow: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  days: { flexDirection: 'row', gap: spacing.xs },
  day: {
    flex: 1,
    minWidth: MIN_TOUCH_SIZE,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  today: { borderColor: colors.primary },
  selected: { backgroundColor: colors.primary, borderColor: colors.primary },
  pressed: { opacity: 0.7 },
  weekday: { ...type.footnote, color: colors.textMuted },
  date: { ...tabular(type.heading), color: colors.text },
  onSelected: { color: colors.primaryText },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { backgroundColor: colors.primary },
  dotOnSelected: { backgroundColor: colors.primaryText },
}));
