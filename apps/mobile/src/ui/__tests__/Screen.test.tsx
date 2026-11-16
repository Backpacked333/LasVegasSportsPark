/**
 * Screen v2 (ADR-008, SPK-UX-009): the large title, header actions, pull to refresh, the sticky
 * footer above a floating bar and the list modes; plain `children` and `scroll={false}` behave
 * as before.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { FlatList, Pressable, RefreshControl, ScrollView, SectionList, Text } from 'react-native';
import { pullToRefresh, renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import { BottomBarInsetContext, Screen } from '../Screen';
import { classicTheme, legendsTheme, type } from '../theme';

const GAMES = [
  { id: 'g1', title: 'Game at 9 am' },
  { id: 'g2', title: 'Game at 11 am' },
];

function paddingBottom(style: unknown): number {
  const parts = (Array.isArray(style) ? style : [style]).filter(Boolean) as {
    paddingBottom?: number;
  }[];
  return parts.reduce((value, part) => part.paddingBottom ?? value, 0);
}

describe('Screen v2 (ADR-008)', () => {
  it('keeps the plain screen: one scroll view with the children, no title and no refresh', async () => {
    await renderSurface(
      <Screen>
        <Text>Content</Text>
      </Screen>,
    );
    expect(screen.getByText('Content')).toBeOnTheScreen();
    expect(screen.UNSAFE_getAllByType(ScrollView)).toHaveLength(1);
    expect(screen.UNSAFE_getByType(ScrollView).props.refreshControl).toBeUndefined();
    expect(screen.queryByRole('header')).toBeNull();
  });

  it('keeps scroll={false}: the children without a scroll view', async () => {
    await renderSurface(
      <Screen scroll={false}>
        <Text>Fixed</Text>
      </Screen>,
    );
    expect(screen.getByText('Fixed')).toBeOnTheScreen();
    expect(screen.UNSAFE_queryAllByType(ScrollView)).toHaveLength(0);
  });

  it('SPK-UX-009: draws the title as a large header with its actions beside it', async () => {
    const onPass = jest.fn();
    await renderSurface(
      <Screen
        title="Home"
        headerActions={
          <Pressable accessibilityRole="button" accessibilityLabel="Facility pass" onPress={onPass}>
            <Text>Pass</Text>
          </Pressable>
        }
      >
        <Text>Next up</Text>
      </Screen>,
    );
    expect(screen.getByRole('header', { name: 'Home' })).toHaveStyle({
      fontSize: type.largeTitle.fontSize,
    });
    fireEvent.press(screen.getByRole('button', { name: 'Facility pass' }));
    expect(onPass).toHaveBeenCalledTimes(1);
  });

  it('pulls to refresh, and shows the refresh while it runs', async () => {
    const onRefresh = jest.fn();
    const { rerender } = await renderSurface(
      <Screen onRefresh={onRefresh}>
        <Text>Content</Text>
      </Screen>,
    );
    await pullToRefresh(screen);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
    rerender(
      <Screen onRefresh={onRefresh} refreshing>
        <Text>Content</Text>
      </Screen>,
    );
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  });

  it('SPK-UX-009: keeps the footer above a floating bar, and the content ends at the footer', async () => {
    const view = (inset: number) => (
      <BottomBarInsetContext.Provider value={inset}>
        <Screen
          footer={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Review"
              style={{ minHeight: 44 }}
            >
              <Text>Review</Text>
            </Pressable>
          }
        >
          <Text>Cart</Text>
        </Screen>
      </BottomBarInsetContext.Provider>
    );
    const { rerender } = await renderSurface(view(0));
    const contentPadding = () =>
      paddingBottom(screen.UNSAFE_getByType(ScrollView).props.contentContainerStyle);
    const withoutBar = contentPadding();
    rerender(view(83));
    // The footer stands on the bar; the scrolling content does not reach under it.
    expect(contentPadding()).toBe(withoutBar);
    // The nearest host view around the footer content holds it above the bar.
    let node = screen.getByRole('button', { name: 'Review' }).parent;
    while (node && !(typeof node.type === 'string' && paddingBottom(node.props.style) > 0)) {
      node = node.parent;
    }
    expect(paddingBottom(node?.props.style)).toBe(83);
  });

  it('list mode: a FlatList of the items with the title and children as its header', async () => {
    const onRefresh = jest.fn();
    await renderSurface(
      <Screen
        title="Calendar"
        onRefresh={onRefresh}
        list={{
          data: GAMES,
          keyExtractor: (item) => item.id,
          renderItem: ({ item }) => <Text>{item.title}</Text>,
        }}
      >
        <Text>This week</Text>
      </Screen>,
    );
    expect(screen.UNSAFE_getAllByType(FlatList)).toHaveLength(1);
    expect(screen.getByRole('header', { name: 'Calendar' })).toBeOnTheScreen();
    expect(screen.getByText('This week')).toBeOnTheScreen();
    expect(screen.getByText('Game at 11 am')).toBeOnTheScreen();
    await pullToRefresh(screen);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('list mode: a SectionList when given sections', async () => {
    await renderSurface(
      <Screen
        title="Calendar"
        sections={{
          sections: [{ title: 'Saturday', data: GAMES }],
          keyExtractor: (item) => item.id,
          renderItem: ({ item }) => <Text>{item.title}</Text>,
          renderSectionHeader: ({ section }) => (
            <Text accessibilityRole="header">{section.title}</Text>
          ),
        }}
      />,
    );
    expect(screen.UNSAFE_getAllByType(SectionList)).toHaveLength(1);
    expect(screen.getByRole('header', { name: 'Saturday' })).toBeOnTheScreen();
    expect(screen.getByText('Game at 9 am')).toBeOnTheScreen();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('takes the page colour and refresh accent of the %s theme', async (name, theme) => {
    await renderSurface(
      <Screen onRefresh={() => undefined}>
        <Text>Content</Text>
      </Screen>,
      { theme: name },
    );
    expect(screen.UNSAFE_getByType(RefreshControl).props.tintColor).toBe(theme.colors.primary);
    expect(screen.UNSAFE_getByType(ScrollView).props.indicatorStyle).toBe(
      theme.dark ? 'white' : 'black',
    );
  });

  it('SPK-UX-009 reduced motion: the same frame with or without motion', async () => {
    const view = (
      <Screen title="Teams">
        <Text>Content</Text>
      </Screen>
    );
    const { rerender } = await renderSurface(view);
    rerender(<MotionProvider reduced={false}>{view}</MotionProvider>);
    expect(screen.getByRole('header', { name: 'Teams' })).toBeOnTheScreen();
    expect(screen.UNSAFE_getAllByType(ScrollView)).toHaveLength(1);
  });
});
