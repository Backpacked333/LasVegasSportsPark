/**
 * The tab bar on glass (ADR-001, SPK-UX-002, SPK-UX-009): where the device offers glass the bar
 * floats over the page as one glass surface and screens leave room for it; without glass the bar
 * is the solid bar in the layout. The five tabs and their labels are the same either way.
 */
import { render, waitFor } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';
import { ScrollView, StyleSheet, Text, type TextStyle } from 'react-native';
import { createTestApp } from '../../testing/test-app';
import { GlassProvider, type GlassMode } from '../../ui/GlassSurface';
import { BottomBarInsetContext, Screen } from '../../ui/Screen';
import { DESTINATIONS } from '../destinations';
import { RootNavigator } from '../RootNavigator';
import { TAB_ROW_HEIGHT } from '../TabsNavigator';

const EMPTY_INBOX = { status: 200, body: { items: [], nextCursor: null } };

function renderApp(mode?: GlassMode) {
  const app = createTestApp({ routes: { 'GET /me/inbox': EMPTY_INBOX } });
  const TestRootLayout = () => (
    <app.wrapper>
      {mode ? (
        <GlassProvider mode={mode}>
          <RootNavigator />
        </GlassProvider>
      ) : (
        <RootNavigator />
      )}
    </app.wrapper>
  );
  return renderRouter(
    { appDir: 'app', overrides: { _layout: TestRootLayout } },
    { initialUrl: '/' },
  );
}

describe('tab bar on glass (ADR-001)', () => {
  it.each(['liquid', 'blur'] as const)(
    'floats as one glass surface in %s mode, with the same five labelled tabs (SPK-UX-002)',
    async (mode) => {
      renderApp(mode);
      expect(await screen.findByTestId('tab-bar-glass')).toBeOnTheScreen();
      for (const d of DESTINATIONS) {
        expect(await screen.findByTestId(`tab-${d.name}`)).toHaveProp(
          'accessibilityLabel',
          d.accessibilityLabel,
        );
      }
    },
  );

  it('is the solid bar in the layout without glass (Android, web, reduce transparency)', async () => {
    renderApp();
    expect(await screen.findByTestId('tab-index')).toBeOnTheScreen();
    expect(screen.queryByTestId('tab-bar-glass')).toBeNull();
  });

  it('SPK-UX-009: the labels have a line of their own, so "Explore" is never cut at the bottom', async () => {
    renderApp();
    const label = await screen.findByText('Explore');
    const style = StyleSheet.flatten(label.props.style) as TextStyle;
    expect(style.lineHeight).toBeGreaterThanOrEqual(15);
    // The row holds the item's padding, the 30 pt icon pill, the gap and the label line.
    expect(TAB_ROW_HEIGHT).toBeGreaterThanOrEqual(5 + 30 + 2 + (style.lineHeight ?? 0) + 5);
  });
});

describe('Screen under a floating bar (SPK-UX-009)', () => {
  function bottomPadding(style: unknown): number {
    const parts = (Array.isArray(style) ? style : [style]).filter(Boolean) as {
      paddingBottom?: number;
    }[];
    return parts.reduce((value, part) => part.paddingBottom ?? value, 0);
  }

  it('ends its content above the bar, so the last control is never covered', async () => {
    const app = createTestApp({});
    const view = (inset: number) => (
      <BottomBarInsetContext.Provider value={inset}>
        <Screen>
          <Text>Last row</Text>
        </Screen>
      </BottomBarInsetContext.Provider>
    );
    const { rerender, UNSAFE_getByType } = render(view(0), { wrapper: app.wrapper });
    // The providers settle (session, connectivity) before anything is measured.
    expect(await screen.findByText('Last row')).toBeOnTheScreen();
    await waitFor(() => expect(app.sessionStore).toBeDefined());
    const scrollProps = () =>
      UNSAFE_getByType(ScrollView).props as {
        contentContainerStyle: unknown;
        scrollIndicatorInsets: unknown;
      };
    const withoutBar = bottomPadding(scrollProps().contentContainerStyle);
    rerender(view(83));
    expect(bottomPadding(scrollProps().contentContainerStyle)).toBe(withoutBar + 83);
    expect(scrollProps().scrollIndicatorInsets).toEqual({ bottom: 83 });
    expect(screen.getByText('Last row')).toBeOnTheScreen();
  });
});
