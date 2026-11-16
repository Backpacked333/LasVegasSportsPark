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
import { MOTION_DURATIONS, motionFor } from '../motion';
import { StateView } from '../StateView';
import { ThemeProvider } from '../ThemeProvider';
import {
  MIN_TOUCH_SIZE,
  THEMES,
  avatarToneFor,
  buttonHeight,
  classicTheme,
  durationsFor,
  elevation,
  layout,
  legendsTheme,
  makeStyles,
  motionTokens,
  radius,
  spacing,
  tabular,
  tabularFigures,
  type,
  useTheme,
  type ElevationLevel,
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

/** The alpha of a `#RRGGBB` (opaque) or `#RRGGBBAA` token, from 0 to 1. */
function alpha(hex: string): number {
  return hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
}

/**
 * A token with alpha drawn over an opaque `#RRGGBB` colour (source-over, in sRGB as the platforms
 * blend), as the `#RRGGBB` colour seen on screen. An opaque token comes back as itself.
 */
function composite(top: string, under: string): string {
  const a = alpha(top);
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) => Math.round(channel(top, i) * a + channel(under, i) * (1 - a)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/** Contrast of `fg` drawn on `bg`, both composited onto `base` first where they carry alpha. */
function contrastOn(fg: string, bg: string, base: string): number {
  const surface = composite(bg, base);
  return contrast(composite(fg, surface), surface);
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

describe('tokens v2 (ADR-008): contrast of the new pairings (SPK-UX-009)', () => {
  /** [foreground, background] pairs of the v2 surfaces drawn as text: 4.5:1 or more. */
  const V2_TEXT_PAIRS: readonly (readonly [keyof ThemeColors, keyof ThemeColors])[] = [
    ['text', 'elevated'],
    ['textMuted', 'elevated'],
    ['primary', 'elevated'],
    ['onSheet', 'sheet'],
    ['textMuted', 'sheet'],
    ['primary', 'sheet'],
    ['danger', 'sheet'],
    ['onTonal', 'tonal'],
    ['onToast', 'toast'],
    ['onCountBadge', 'countBadge'],
  ];

  describe.each(Object.values(THEMES))('$name theme', (theme: Theme) => {
    const { colors } = theme;

    it('SPK-UX-009 contrast: text on raised cards, sheets, tonal fills, toasts and badges reaches 4.5:1', () => {
      const ratios = V2_TEXT_PAIRS.map(
        ([fg, bg]) => [fg, bg, contrastOn(colors[fg], colors[bg], colors.page)] as const,
      );
      expect(ratios.filter(([, , ratio]) => ratio < 4.5)).toEqual([]);
    });

    it('SPK-UX-009 contrast: the surfaces text sits on are opaque, so the ratios above are what is seen', () => {
      for (const [fg, bg] of V2_TEXT_PAIRS) {
        expect([fg, alpha(colors[fg])]).toEqual([fg, 1]);
        expect([bg, alpha(colors[bg])]).toEqual([bg, 1]);
      }
    });

    it('ADR-008: onMedia and onMediaMuted over scrimEnd reach 4.5:1 on pure white and on pure black artwork', () => {
      // Any artwork pixel lies between these two, so text on the scrim is readable on every image.
      for (const artwork of ['#FFFFFF', '#000000']) {
        expect(contrastOn(colors.onMedia, colors.scrimEnd, artwork)).toBeGreaterThanOrEqual(4.5);
        expect(contrastOn(colors.onMediaMuted, colors.scrimEnd, artwork)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    });

    it('ADR-008: the scrim fades from clear to translucent in one hue; the backdrop is translucent', () => {
      expect(alpha(colors.scrimStart)).toBe(0);
      expect(alpha(colors.scrimEnd)).toBeGreaterThan(0);
      expect(alpha(colors.scrimEnd)).toBeLessThan(1);
      expect(colors.scrimStart.slice(0, 7)).toBe(colors.scrimEnd.slice(0, 7));
      expect(alpha(colors.backdrop)).toBeGreaterThan(0);
      expect(alpha(colors.backdrop)).toBeLessThan(1);
      // Text tokens and shadow are opaque (shadow opacity is set per elevation level).
      for (const token of ['onMedia', 'onMediaMuted', 'shadow'] as const) {
        expect(alpha(colors[token])).toBe(1);
      }
    });

    it('PA-11, SPK-UX-009 contrast: a count badge (the inbox entry point off the tab bar) stands out 3:1 from the surfaces around it', () => {
      for (const around of ['page', 'background', 'surface', 'elevated', 'sheet'] as const) {
        expect([around, contrast(colors.countBadge, colors[around]) >= 3]).toEqual([around, true]);
      }
    });

    it('ADR-008: the skeleton highlight differs from its fill, and both differ from the card', () => {
      expect(colors.skeletonHighlight).not.toBe(colors.skeleton);
      expect(colors.skeleton).not.toBe(colors.background);
    });

    it('SPK-UX-009 contrast: initials on every avatar tone reach 4.5:1', () => {
      expect(theme.avatarTones.length).toBeGreaterThanOrEqual(6);
      const failing = theme.avatarTones.filter(
        ({ background, foreground }) => contrast(foreground, background) < 4.5,
      );
      expect(failing).toEqual([]);
    });
  });

  it('SPK-UX-009 contrast: on classic a toast and an open sheet stand out 3:1 from what is behind them', () => {
    const { colors } = classicTheme;
    expect(contrast(colors.toast, colors.page)).toBeGreaterThanOrEqual(3);
    expect(contrast(colors.sheet, composite(colors.backdrop, colors.page))).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('ADR-008: Legends mode lifts with lighter surfaces: raised cards and sheets are lighter than a card', () => {
    const { colors } = legendsTheme;
    for (const lifted of ['elevated', 'sheet', 'toast'] as const) {
      expect(luminance(colors[lifted])).toBeGreaterThan(luminance(colors.background));
    }
    expect(luminance(colors.skeletonHighlight)).toBeGreaterThan(luminance(colors.skeleton));
  });

  it('ADR-008: both themes have the same number of avatar tones, so a person keeps their slot', () => {
    expect(legendsTheme.avatarTones).toHaveLength(classicTheme.avatarTones.length);
    const tone = avatarToneFor(classicTheme, 'person-0193');
    expect(avatarToneFor(classicTheme, 'person-0193')).toBe(tone);
    expect(classicTheme.avatarTones).toContain(tone);
    const slot = classicTheme.avatarTones.indexOf(tone);
    expect(avatarToneFor(legendsTheme, 'person-0193')).toBe(legendsTheme.avatarTones[slot]);
    // Different people spread over the tones.
    const used = new Set(
      Array.from({ length: 24 }, (_, i) => avatarToneFor(classicTheme, `person-${i}`)),
    );
    expect(used.size).toBeGreaterThan(3);
  });
});

describe('tokens v2 (ADR-008): elevation', () => {
  const LEVELS: readonly ElevationLevel[] = ['card', 'raised', 'sheet', 'bar'];

  it('classic: each level is a shadow in the shadow colour on its surface, with no border', () => {
    const { colors } = classicTheme;
    const surfaces = LEVELS.map((level) => elevation(classicTheme, level).backgroundColor);
    expect(surfaces).toEqual([colors.background, colors.elevated, colors.sheet, colors.background]);
    for (const level of LEVELS) {
      const style = elevation(classicTheme, level);
      expect(typeof style.boxShadow).toBe('string');
      expect(style.boxShadow).toContain(colors.shadow);
      expect(style.borderWidth).toBeUndefined();
    }
    // Sheets and bottom bars cast upwards, cards downwards.
    expect(elevation(classicTheme, 'card').boxShadow).toMatch(/^0px 1px /);
    expect(elevation(classicTheme, 'sheet').boxShadow).toMatch(/^0px -\d+px /);
    expect(elevation(classicTheme, 'bar').boxShadow).toMatch(/^0px -\d+px /);
  });

  it('Legends mode: each level is a lighter surface with a hairline border and no shadow', () => {
    const { colors } = legendsTheme;
    for (const level of LEVELS) {
      const style = elevation(legendsTheme, level);
      expect(style.boxShadow).toBeUndefined();
      expect(style.borderWidth).toBe(StyleSheet.hairlineWidth);
      expect([colors.border, colors.control]).toContain(style.borderColor);
    }
    expect(elevation(legendsTheme, 'raised').backgroundColor).toBe(colors.elevated);
    expect(elevation(legendsTheme, 'sheet').backgroundColor).toBe(colors.sheet);
  });

  it('returns the same style object for the same theme and level', () => {
    expect(elevation(classicTheme, 'raised')).toBe(elevation(classicTheme, 'raised'));
    expect(elevation(legendsTheme, 'raised')).not.toBe(elevation(classicTheme, 'raised'));
  });
});

describe('tokens v2 (ADR-008): type, spacing, layout, radius and button heights', () => {
  it('adds the type scale at its sizes and line heights; the existing styles stay', () => {
    const sizes = (['largeTitle', 'title1', 'title3', 'callout', 'footnote', 'micro'] as const).map(
      (key) => [key, type[key].fontSize, type[key].lineHeight],
    );
    expect(sizes).toEqual([
      ['largeTitle', 34, 41],
      ['title1', 26, 32],
      ['title3', 19, 24],
      ['callout', 15, 21],
      ['footnote', 13, 18],
      ['micro', 12, 16],
    ]);
    expect(Object.keys(type)).toEqual(
      expect.arrayContaining(['display', 'title', 'heading', 'eyebrow', 'body', 'caption']),
    );
    expect([type.body.fontSize, type.caption.fontSize, type.display.fontSize]).toEqual([
      16, 14, 30,
    ]);
  });

  it('tabular figures keep times, scores and the pass from shifting', () => {
    expect(tabularFigures.fontVariant).toEqual(['tabular-nums']);
    const score = tabular(type.title1);
    expect(score).toMatchObject({ ...type.title1, fontVariant: ['tabular-nums'] });
    expect(type.title1).not.toHaveProperty('fontVariant');
  });

  it('adds spacing, layout and radius steps; the existing steps stay', () => {
    expect(spacing).toEqual({ xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 });
    expect(layout).toEqual({ gutter: 20, cardGap: 12, sectionGap: 28 });
    expect(radius).toEqual({ sm: 10, md: 14, image: 16, lg: 20, xl: 24, sheet: 28, pill: 999 });
  });

  it('SPK-UX-009: button heights keep 44 and 48 and add 56 for sticky bars', () => {
    expect(buttonHeight).toEqual({ compact: 44, regular: 48, sticky: 56 });
    expect(buttonHeight.compact).toBe(MIN_TOUCH_SIZE);
  });
});

describe('tokens v2 (ADR-008): motion', () => {
  it('durations are 0, 120, 220 and 320 ms, with a press scale of 0.97', () => {
    expect(motionTokens.durations).toEqual({ instant: 0, fast: 120, base: 220, slow: 320 });
    expect(motionTokens.pressScale).toBe(0.97);
  });

  it('SPK-UX-009: every duration is 0 while motion is reduced', () => {
    expect(Object.values(durationsFor(true))).toEqual([0, 0, 0, 0]);
    expect(durationsFor(false)).toEqual(motionTokens.durations);
  });

  it('easings are cubic-bezier control points and springs are physical configs', () => {
    for (const curve of Object.values(motionTokens.easings)) {
      expect(curve).toHaveLength(4);
      expect([curve[0], curve[2]].every((x) => x >= 0 && x <= 1)).toBe(true);
    }
    for (const spring of Object.values(motionTokens.springs)) {
      expect(spring.damping).toBeGreaterThan(0);
      expect(spring.stiffness).toBeGreaterThan(0);
      expect(spring.mass).toBeGreaterThan(0);
    }
  });

  it('useMotion reads these tokens (src/ui/motion.tsx)', () => {
    expect(MOTION_DURATIONS).toBe(motionTokens.durations);
    expect(motionFor(false).duration('slow')).toBe(motionTokens.durations.slow);
    expect(motionFor(true).duration('slow')).toBe(0);
  });
});
