/**
 * Carousel (ADR-008, SPK-UX-009): a horizontal list with its own name that snaps card by card.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { FlatList, Pressable, StyleSheet, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { Carousel } from '../Carousel';
import { MotionProvider } from '../motion';
import { layout } from '../theme';

const ITEMS = [
  { id: 'a', title: 'Fall league' },
  { id: 'b', title: 'Futsal' },
];

function Cards({ onPress = () => undefined }: { onPress?: (id: string) => void }) {
  return (
    <Carousel
      data={ITEMS}
      keyExtractor={(item) => item.id}
      accessibilityLabel="Upcoming activities"
      itemWidth={240}
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.title}
          onPress={() => onPress(item.id)}
          style={{ width: 240, minHeight: 44 }}
        >
          <Text>{item.title}</Text>
        </Pressable>
      )}
    />
  );
}

describe('Carousel (ADR-008)', () => {
  it('SPK-UX-009: is a list named for screen readers whose cards are each reached', async () => {
    const onPress = jest.fn();
    await renderSurface(<Cards onPress={onPress} />);
    // The list keeps its cards as separate elements, so it is a named list, not one element.
    expect(screen.getByLabelText('Upcoming activities')).toHaveProp('accessibilityRole', 'list');
    fireEvent.press(screen.getByRole('button', { name: 'Futsal' }));
    expect(onPress).toHaveBeenCalledWith('b');
    expect(
      StyleSheet.flatten(screen.getByRole('button', { name: 'Fall league' }).props.style).minHeight,
    ).toBeGreaterThanOrEqual(44);
  });

  it('scrolls sideways and snaps every card width plus the gap, inside the gutter', async () => {
    await renderSurface(<Cards />);
    const list = screen.UNSAFE_getByType(FlatList).props;
    expect(list.horizontal).toBe(true);
    expect(list.snapToInterval).toBe(240 + layout.cardGap);
    expect(list.decelerationRate).toBe('fast');
    expect(StyleSheet.flatten(list.contentContainerStyle)).toMatchObject({
      paddingHorizontal: layout.gutter,
      gap: layout.cardGap,
    });
  });

  it('SPK-UX-009 reduced motion: snapping is the platform scroll, the same with or without motion', async () => {
    const { rerender } = await renderSurface(<Cards />);
    const before = screen.UNSAFE_getByType(FlatList).props.snapToInterval;
    rerender(
      <MotionProvider reduced={false}>
        <Cards />
      </MotionProvider>,
    );
    expect(screen.UNSAFE_getByType(FlatList).props.snapToInterval).toBe(before);
  });

  it.each(['classic', 'legends'] as const)('renders its cards in the %s theme', async (theme) => {
    await renderSurface(<Cards />, { theme });
    expect(screen.getByText('Fall league')).toBeOnTheScreen();
    expect(screen.getByText('Futsal')).toBeOnTheScreen();
  });
});
