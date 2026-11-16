/**
 * Legends mode (a dark theme with a gold accent, switched at runtime and kept between launches)
 * and the theme tokens behind it: SPK-UX-009 (the switch is exposed to assistive technology with
 * its state, the state is also in words, text keeps its contrast in both themes) and SPK-UX-010
 * (one visual system: no screen keeps a colour of its own).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StatusBar, StyleSheet, Text } from 'react-native';
import { HeaderTitle } from '../../navigation/TabsNavigator';
import { createTestApp } from '../../testing/test-app';
import { Button } from '../Button';
import { Card } from '../Card';
import { LegendsModeToggle } from '../LegendsModeToggle';
import { ListRow } from '../ListRow';
import { StateView } from '../StateView';
import { ThemeProvider } from '../ThemeProvider';
import {
  THEMES,
  classicTheme,
  legendsTheme,
  makeStyles,
  useTheme,
  type Theme,
  type ThemeColors,
  type ThemeName,
} from '../theme';
import { MemoryThemeStore, parseThemeName } from '../theme-preference';

/** WCAG 2 relative luminance and contrast ratio of two `#RRGGBB` colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const flat = (element: { props: { style?: unknown } }) =>
  StyleSheet.flatten(element.props.style as never) as Record<string, unknown>;

/** A themed sheet declared the way screens declare theirs. */
const useProbeStyles = makeStyles(({ colors }) => ({ probe: { color: colors.text } }));
function Probe() {
  const styles = useProbeStyles();
  const { name } = useTheme();
  return (
    <Text style={styles.probe} testID="probe">
      {name}
    </Text>
  );
}

/** Renders under the theme provider alone, with a memory store (`'legends'` to start in Legends mode). */
function renderThemed(ui: ReactElement, stored: ThemeName | null = null) {
  const store = new MemoryThemeStore(stored);
  const view = render(<ThemeProvider store={store}>{ui}</ThemeProvider>);
  return { store, view };
}

describe('Legends mode switch (SPK-UX-009)', () => {
  it('is a switch named "Legends mode" that exposes its state and says it in words', () => {
    renderThemed(<LegendsModeToggle />);
    const toggle = screen.getByRole('switch', { name: 'Legends mode' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByTestId('legends-mode-toggle-state')).toHaveTextContent(/^Off\./);
    fireEvent.press(toggle);
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeChecked();
    expect(screen.getByTestId('legends-mode-toggle-state')).toHaveTextContent(/^On\./);
    // Only the row is focusable: the platform switch drawn inside it is not a second control.
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });

  it('has a touch target of at least 44 pt', () => {
    render(<LegendsModeToggle />);
    expect(flat(screen.getByTestId('legends-mode-toggle')).minHeight).toBeGreaterThanOrEqual(44);
  });

  it('switches the colours on screen at once, and back', () => {
    renderThemed(
      <>
        <LegendsModeToggle />
        <Probe />
        <Button label="Continue" onPress={() => undefined} />
      </>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('classic');
    expect(flat(screen.getByTestId('probe')).color).toBe(classicTheme.colors.text);
    expect(flat(screen.getByRole('button', { name: 'Continue' })).backgroundColor).toBe(
      classicTheme.colors.primary,
    );

    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('legends');
    expect(flat(screen.getByTestId('probe')).color).toBe(legendsTheme.colors.text);
    expect(flat(screen.getByRole('button', { name: 'Continue' })).backgroundColor).toBe(
      legendsTheme.colors.primary,
    );

    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(flat(screen.getByTestId('probe')).color).toBe(classicTheme.colors.text);
  });

  it('keeps the choice between launches: stored on switching, read before the first frame', () => {
    const first = renderThemed(<LegendsModeToggle />);
    expect(first.store.read()).toBeNull();
    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(first.store.read()).toBe('legends');
    first.view.unmount();

    // The next launch starts in Legends mode on its first render (no flash of the classic theme).
    const second = renderThemed(
      <>
        <LegendsModeToggle />
        <Probe />
      </>,
      first.store.read(),
    );
    expect(screen.getByRole('switch', { name: 'Legends mode' })).toBeChecked();
    expect(flat(screen.getByTestId('probe')).color).toBe(legendsTheme.colors.text);

    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(second.store.read()).toBe('classic');
  });

  it("the app's providers read and keep the choice through the injected store", async () => {
    const app = createTestApp({ theme: 'legends' });
    render(
      <>
        <LegendsModeToggle />
        <Probe />
      </>,
      { wrapper: app.wrapper },
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('legends');
    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('classic');
    expect(app.themeStore.read()).toBe('classic');
    // Let the providers finish reading the stored session and the connection.
    await act(async () => {});
  });

  it('without a store the choice still applies while the app is open', () => {
    render(
      <ThemeProvider>
        <LegendsModeToggle />
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.press(screen.getByRole('switch', { name: 'Legends mode' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('legends');
  });

  it('a component rendered without a provider takes the classic theme', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('classic');
  });

  it('reads only the two theme names from storage', () => {
    expect(parseThemeName('legends')).toBe('legends');
    expect(parseThemeName('classic')).toBe('classic');
    expect(parseThemeName('dark')).toBeNull();
    expect(parseThemeName(null)).toBeNull();
    expect(new MemoryThemeStore('legends').read()).toBe('legends');
  });
});

describe('the whole app follows the theme (SPK-UX-010)', () => {
  it('shared primitives, the destination header and the status bar are drawn in Legends colours', () => {
    const setBarStyle = jest.spyOn(StatusBar, 'setBarStyle');
    renderThemed(
      <>
        <HeaderTitle>Schedule</HeaderTitle>
        <Card testID="card">
          <Text>content</Text>
        </Card>
        <ListRow title="Family and permissions" onPress={() => undefined} testID="row" />
        <StateView variant="empty" title="No teams yet" description="Teams appear here." />
      </>,
      'legends',
    );
    const { colors } = legendsTheme;
    expect(flat(screen.getByRole('header', { name: 'Schedule' })).color).toBe(colors.text);
    expect(flat(screen.getByTestId('card')).backgroundColor).toBe(colors.background);
    expect(flat(screen.getByTestId('card')).borderColor).toBe(colors.border);
    expect(flat(screen.getByTestId('row')).backgroundColor).toBe(colors.background);
    expect(flat(screen.getByTestId('state-empty')).backgroundColor).toBe(colors.background);
    expect(flat(screen.getByRole('header', { name: 'No teams yet' })).color).toBe(colors.text);
    // Light status bar content on the dark page; dark content in the classic theme.
    expect(setBarStyle).toHaveBeenLastCalledWith('light-content');
  });

  it('the classic theme keeps dark status bar content', () => {
    const setBarStyle = jest.spyOn(StatusBar, 'setBarStyle');
    renderThemed(<Probe />);
    expect(setBarStyle).toHaveBeenLastCalledWith('dark-content');
  });

  it('a themed stylesheet is created once per theme and reused', () => {
    const sheets: unknown[] = [];
    function Capture() {
      sheets.push(useProbeStyles());
      return null;
    }
    const { view, store } = renderThemed(<Capture />);
    view.rerender(
      <ThemeProvider store={store}>
        <Capture />
      </ThemeProvider>,
    );
    expect(sheets.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sheets).size).toBe(1);
  });

  it('no screen keeps a colour of its own: colour literals live only in the theme tokens', () => {
    const root = path.resolve(__dirname, '../../..');
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (name === '__tests__' || name === 'node_modules') return [];
        if (statSync(full).isDirectory()) return sources(full);
        return /\.tsx?$/.test(name) ? [full] : [];
      });
    const files = [...sources(path.join(root, 'src')), ...sources(path.join(root, 'app'))].filter(
      (file) => !file.endsWith(path.join('ui', 'theme.ts')),
    );
    expect(files.length).toBeGreaterThan(100);
    const literal = /(['"`])#[0-9a-fA-F]{3,8}\1|\brgba?\(|\bhsla?\(/;
    const offenders = files.filter((file) => literal.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(root, file))).toEqual([]);
  });
});

describe('contrast of the theme tokens (SPK-UX-009)', () => {
  /** [foreground, background] pairs drawn as text: 4.5:1 or more. */
  const TEXT_PAIRS: readonly (readonly [keyof ThemeColors, keyof ThemeColors])[] = [
    ['text', 'page'],
    ['text', 'background'],
    ['text', 'surface'],
    ['textMuted', 'page'],
    ['textMuted', 'background'],
    ['textMuted', 'surface'],
    ['primaryText', 'primary'],
    ['primaryText', 'primaryPressed'],
    ['primaryText', 'danger'],
    ['primary', 'background'],
    ['primary', 'page'],
    ['danger', 'background'],
    ['danger', 'page'],
    ['onFloodlight', 'floodlight'],
    ['onNight', 'night'],
    ['onNight', 'nightRaised'],
    ['onNight', 'pitch'],
    ['onNightBody', 'night'],
    ['onNightBody', 'pitch'],
    ['nightText', 'night'],
    ['nightMuted', 'night'],
    ['nightMuted', 'nightRaised'],
    ['floodlight', 'night'],
    ['floodlight', 'pitch'],
    ['tabActive', 'background'],
    ['onChipSelected', 'chipSelected'],
    ['chipSelectedIcon', 'chipSelected'],
    ['night', 'onNight'],
  ];

  describe.each(Object.values(THEMES))('$name theme', (theme: Theme) => {
    it('text and its surface reach 4.5:1 for every pairing the app draws', () => {
      const failing = TEXT_PAIRS.filter(
        ([fg, bg]) => contrast(theme.colors[fg], theme.colors[bg]) < 4.5,
      );
      expect(failing).toEqual([]);
    });

    it('each status tone reaches 4.5:1 on its tint and on a card', () => {
      for (const tone of Object.keys(theme.toneBackgrounds) as (keyof Theme['toneBackgrounds'])[]) {
        expect(contrast(theme.colors[tone], theme.toneBackgrounds[tone])).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(contrast(theme.colors[tone], theme.colors.background)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('a decorative icon on a kind colour reaches 3:1', () => {
      for (const kind of Object.values(theme.kindColors)) {
        expect(contrast(theme.colors.primaryText, kind)).toBeGreaterThanOrEqual(3);
      }
    });
  });

  it('Legends mode is dark with a gold accent; the classic theme is unchanged in kind', () => {
    expect(legendsTheme.dark).toBe(true);
    expect(classicTheme.dark).toBe(false);
    expect(luminance(legendsTheme.colors.page)).toBeLessThan(0.02);
    // Gold: red above green above blue, and bright.
    const [r, g, b] = [1, 3, 5].map((i) =>
      parseInt(legendsTheme.colors.primary.slice(i, i + 2), 16),
    ) as [number, number, number];
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(luminance(legendsTheme.colors.primary)).toBeGreaterThan(0.4);
    // The same token names in both themes.
    expect(Object.keys(legendsTheme.colors).sort()).toEqual(
      Object.keys(classicTheme.colors).sort(),
    );
  });
});
