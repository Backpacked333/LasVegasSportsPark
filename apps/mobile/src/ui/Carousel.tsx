/**
 * Carousel: a horizontal row of cards that snaps card by card (ADR-008), as a FlatList so a long
 * row stays cheap. The row is a list for screen readers with its own name ("Upcoming activities"),
 * and each card in it is one element (`MediaCard`); swiping through with VoiceOver or TalkBack
 * reaches every card in order (SPK-UX-009).
 *
 * `itemWidth` is the width of one card; the row snaps every `itemWidth + gap` points. The row
 * starts and ends at the screen gutter.
 */
import type { ReactElement } from 'react';
import { FlatList, type ListRenderItem, type StyleProp, type ViewStyle } from 'react-native';
import { layout, makeStyles } from './theme';

export interface CarouselProps<T> {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T, index: number) => string;
  /** The list's name for screen readers, e.g. "Upcoming activities". */
  accessibilityLabel: string;
  /** Width of one card, in points. */
  itemWidth: number;
  gap?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Carousel<T>({
  data,
  renderItem,
  keyExtractor,
  accessibilityLabel,
  itemWidth,
  gap = layout.cardGap,
  style,
  testID,
}: CarouselProps<T>): ReactElement {
  const styles = useStyles();
  return (
    <FlatList
      horizontal
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      accessibilityRole="list"
      accessibilityLabel={accessibilityLabel}
      showsHorizontalScrollIndicator={false}
      snapToInterval={itemWidth + gap}
      snapToAlignment="start"
      decelerationRate="fast"
      disableIntervalMomentum
      contentContainerStyle={[styles.content, { gap }]}
      style={style}
      testID={testID}
    />
  );
}

const useStyles = makeStyles(() => ({
  content: { paddingHorizontal: layout.gutter },
}));
