/**
 * Design tokens of the park visual system (SPK-UX-010: clear hierarchy, strong readability in busy
 * facilities, restrained animation), shared with the staff dashboard, in two themes with the same
 * token names: classic (a calm warm white, white cards, pitch green as the accent) and Legends
 * mode (night green surfaces with floodlight accents, handoff M 5d). Archivo for everything, at one width and in sentence
 * case: nothing is set in capitals.
 *
 * Colours are read through the theme in use, never statically: `useTheme()` in a component and
 * `makeStyles` for its stylesheet (below), so the whole app follows the Legends mode switch
 * (`ThemeProvider`, `LegendsModeToggle`). Text on a filled surface uses that surface's own token
 * (`primaryText` on `primary`, `onNight` on `night` and `pitch`, `onFloodlight` on `floodlight`).
 *
 * Colour supports a status but never carries it alone (SPK-UX-009): every tone also has a distinct
 * glyph and a text label (see StatusBadge). Text sizes are base sizes; the OS text-size setting
 * scales them (no `allowFontScaling={false}` anywhere).
 *
 * Fonts are bundled (`@expo-google-fonts/archivo`, `material-symbols`) and loaded by the root
 * layout before anything renders (`FONT_ASSETS`). Each font token names the face and its matching
 * weight, so a face that failed to load still falls back to a system font of the same weight.
 *
 * Tokens v2 (ADR-008, **Proposed** customer visual system v2) add, in both themes: raised, sheet,
 * toast, tonal and count-badge surfaces with their own text colours; a scrim for text over artwork;
 * skeleton fills; initials-avatar tones; four elevation levels (`elevation`: a shadow on classic, a
 * lighter surface and a hairline border in Legends mode, where shadows do not show on night); more
 * type, spacing, layout, radius and button-height steps; and the motion tokens that
 * `src/ui/motion.tsx` reads. Tokens with alpha are `#RRGGBBAA`; their contrast is computed after
 * compositing (`__tests__/theme.test.tsx`).
 */
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_700Bold } from '@expo-google-fonts/archivo/700Bold';
import { Archivo_800ExtraBold } from '@expo-google-fonts/archivo/800ExtraBold';
import { MaterialSymbols_400Regular } from '@expo-google-fonts/material-symbols/400Regular';
import { createContext, useContext } from 'react';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';

/** The classic park palette: night pitch, pitch green and floodlight on desert sand. */
const classicColors = {
  /** Screen background: desert sand. */
  page: '#F5F5F2',
  /** Card and control surface (white). */
  background: '#FFFFFF',
  /** Soft fill: pressed rows, highlighted table rows, empty bars. */
  surface: '#EFEFEB',
  text: '#111614',
  textMuted: '#5F6965',
  /** Card borders. */
  border: '#E9E8E3',
  /** Dividers inside a card. */
  divider: '#F0EFEB',
  /** Borders of controls (unselected chips, secondary buttons). */
  control: '#DBD9D3',
  primary: '#0A7040',
  primaryPressed: '#085A33',
  /** Text and icons on `primary` (and on `danger` fills). Not for night surfaces: use `onNight`. */
  primaryText: '#FFFFFF',
  /** Night pitch: hero cards, the pass, the selected chip. */
  night: '#0C2219',
  nightRaised: '#122C21',
  nightLine: '#2F5444',
  nightMuted: '#9DB3A7',
  nightText: '#B9CBC1',
  /** Titles and labels on `night` and `pitch` surfaces. */
  onNight: '#FFFFFF',
  /** Body text on `night` and `pitch` surfaces. */
  onNightBody: '#E3F1E8',
  /** The team hero band; night-surface text colours apply on it. */
  pitch: '#0A7040',
  /** Floodlight: the one accent; text on it is night. */
  floodlight: '#C6F36B',
  /** Text and icons on `floodlight` fills. */
  onFloodlight: '#0C2219',
  /** Label of the selected tab, on the tab bar. */
  tabActive: '#0C2219',
  /** A selected filter chip: its fill, its label and its decorative icon. */
  chipSelected: '#0C2219',
  onChipSelected: '#FFFFFF',
  chipSelectedIcon: '#C6F36B',
  focus: '#1A4FD6',
  success: '#0A7040',
  warning: '#8A5300',
  /** Border of a warning notice (changes affecting you, the offline banner). */
  warningBorder: '#F0D9A6',
  danger: '#B3261E',
  info: '#1A4FD6',
  neutral: '#4A5651',
  pending: '#5B3FA8',
  // Tokens v2 (ADR-008).
  /** A raised card (`elevation(theme, 'raised')`); on classic the shadow lifts it, not the fill. */
  elevated: '#FFFFFF',
  /** Bottom sheets and their text. */
  sheet: '#FFFFFF',
  onSheet: '#111614',
  /** Behind an open sheet: night pitch at 50%. */
  backdrop: '#0C221980',
  /**
   * The scrim under text on artwork, from `scrimStart` (clear, at the top) to `scrimEnd` (under the
   * text). `onMedia` and `onMediaMuted` over `scrimEnd` reach 4.5:1 on any artwork pixel, from pure
   * white to pure black.
   */
  scrimStart: '#0C221900',
  scrimEnd: '#0C2219B8',
  onMedia: '#FFFFFF',
  onMediaMuted: '#E3F1E8',
  /** Loading placeholders: the fill and the moving highlight (static while motion is reduced). */
  skeleton: '#E8E7E2',
  skeletonHighlight: '#F4F3EF',
  /** A tonal button and a selected tonal chip. */
  tonal: '#E2F0E7',
  onTonal: '#0A5C35',
  /** Toasts: a dark capsule over the light page. */
  toast: '#1B2420',
  onToast: '#FFFFFF',
  /** Shadow colour of the elevation levels (opacity is set per level). */
  shadow: '#0C2219',
  /** Count badges (unread notices, items in a list). */
  countBadge: '#B3261E',
  onCountBadge: '#FFFFFF',
} as const;

/** Every colour token of a theme; the two themes carry the same names. */
export type ThemeColors = { readonly [K in keyof typeof classicColors]: string };

/**
 * Legends mode (redesign handoff M 5d): the same layout on night green surfaces with floodlight
 * accents. The page is night pitch, cards one step lighter with a hairline in the night line
 * colour, primary actions and the selected tab pill in floodlight with night text on them. Pairings
 * checked for contrast (SPK-UX-009; see __tests__/theme.test.tsx): body text on every surface
 * 4.5:1 or more, the label on a floodlight button 4.5:1 or more.
 */
const legendsColors: ThemeColors = {
  page: '#0C2219',
  background: '#122C21',
  surface: '#16352A',
  text: '#FFFFFF',
  textMuted: '#9DB3A7',
  border: '#24473A',
  divider: '#1B3A2E',
  control: '#2F5444',
  primary: '#C6F36B',
  primaryPressed: '#B2DE57',
  primaryText: '#0C2219',
  night: '#081912',
  nightRaised: '#122C21',
  nightLine: '#2F5444',
  nightMuted: '#9DB3A7',
  nightText: '#B9CBC1',
  onNight: '#FFFFFF',
  onNightBody: '#E3F1E8',
  pitch: '#0A5131',
  floodlight: '#C6F36B',
  onFloodlight: '#0C2219',
  tabActive: '#FFFFFF',
  chipSelected: '#C6F36B',
  onChipSelected: '#0C2219',
  chipSelectedIcon: '#0C2219',
  focus: '#C6F36B',
  success: '#7FE0A6',
  warning: '#F5B85C',
  warningBorder: '#5A4416',
  danger: '#FF8A80',
  info: '#8FB5FF',
  neutral: '#B4C4BB',
  pending: '#C4B2FF',
  // Tokens v2 (ADR-008): lighter surfaces instead of shadows.
  elevated: '#16352A',
  sheet: '#16352A',
  onSheet: '#FFFFFF',
  backdrop: '#000000B3',
  scrimStart: '#0C221900',
  scrimEnd: '#0C2219B8',
  onMedia: '#FFFFFF',
  onMediaMuted: '#E3F1E8',
  skeleton: '#16352A',
  skeletonHighlight: '#1E4334',
  tonal: '#1E4334',
  onTonal: '#C6F36B',
  toast: '#24473A',
  onToast: '#FFFFFF',
  shadow: '#000000',
  countBadge: '#FF8A80',
  onCountBadge: '#0C2219',
};

/** Tint behind each status tone (pills, notices, icon tiles); the tone colour is the text. */
const classicToneBackgrounds = {
  success: '#E3F1E8',
  warning: '#FDF0D5',
  danger: '#FBE3E0',
  info: '#E4EBFD',
  neutral: '#EEF0EE',
  pending: '#EEE8FA',
} as const;

export type ThemeToneBackgrounds = {
  readonly [K in keyof typeof classicToneBackgrounds]: string;
};

const legendsToneBackgrounds: ThemeToneBackgrounds = {
  success: '#173A29',
  warning: '#3A2C10',
  danger: '#3D1C19',
  info: '#18284A',
  neutral: '#1E3A2E',
  pending: '#2A2248',
};

/** Activity kinds (schedule stripes, list tiles): a colour always next to the kind's name. */
const classicKindColors = {
  league: '#0B6B3A',
  program: '#2D5BD8',
  rental: '#B07A12',
  party: '#B0306B',
  basketball: '#C4541C',
  dropin: '#5A6660',
} as const;

export type ThemeKindColors = { readonly [K in keyof typeof classicKindColors]: string };

const legendsKindColors: ThemeKindColors = {
  league: '#7FE0A6',
  program: '#9DBBFF',
  rental: '#E8B860',
  party: '#F59AC3',
  basketball: '#FF9E73',
  dropin: '#B4C4BB',
};

/**
 * Initials avatars: a tint and the initials drawn on it (4.5:1 or more). `avatarToneFor` picks the
 * same tone for the same person everywhere; the name is always next to or on the avatar.
 */
export interface AvatarTone {
  readonly background: string;
  readonly foreground: string;
}

const classicAvatarTones: readonly AvatarTone[] = [
  { background: '#DCEFE3', foreground: '#0B5A33' },
  { background: '#E0E8FB', foreground: '#1D409E' },
  { background: '#FBEBCB', foreground: '#734600' },
  { background: '#F8DDE8', foreground: '#8E2152' },
  { background: '#E9E2F8', foreground: '#4E3497' },
  { background: '#D9EEF0', foreground: '#0E5A62' },
];

const legendsAvatarTones: readonly AvatarTone[] = [
  { background: '#173322', foreground: '#7FE0A6' },
  { background: '#18264A', foreground: '#9DBBFF' },
  { background: '#3A2810', foreground: '#F2B865' },
  { background: '#3A1828', foreground: '#F59AC3' },
  { background: '#272044', foreground: '#C4B2FF' },
  { background: '#123236', foreground: '#7FD6DE' },
];

export type ThemeName = 'classic' | 'legends';

/** Everything that changes with the theme. Spacing, radii and type are the same in both. */
export interface Theme {
  readonly name: ThemeName;
  /** A dark theme: light status bar content, dark keyboards and system sheets. */
  readonly dark: boolean;
  readonly colors: ThemeColors;
  readonly toneBackgrounds: ThemeToneBackgrounds;
  readonly kindColors: ThemeKindColors;
  /** Initials-avatar tones; the same number in both themes, so a person keeps their slot. */
  readonly avatarTones: readonly AvatarTone[];
  /** Household person colours, children in order (`src/ui/person-colors.ts`). */
  readonly personColors: readonly PersonColor[];
  /** The account holder's own person colour. */
  readonly selfPersonColor: PersonColor;
}

/**
 * Person colours (redesign handoff, "Person colours"): each member of a household keeps one colour
 * everywhere it appears: the filter chip, the calendar stripe and week-strip dot, the avatar ring
 * and the initials fallback. `accent` draws stripes, dots and rings; `tint` is the initials fill
 * and `onTint` the initials on it (4.5:1 or more). The colour is never the only cue: the person's
 * name or initials are always beside it (SPK-UX-009). `src/ui/person-colors.ts` assigns them.
 */
export interface PersonColor {
  readonly accent: string;
  readonly tint: string;
  readonly onTint: string;
}

/** The children's colours in order: pink, blue, orange, teal, purple (then they repeat). */
const classicPersonColors: readonly PersonColor[] = [
  { accent: '#B0306B', tint: '#F8DDE8', onTint: '#8E2152' },
  { accent: '#1D409E', tint: '#E0E8FB', onTint: '#1D409E' },
  { accent: '#E08A1E', tint: '#FBEBCB', onTint: '#734600' },
  { accent: '#0E8A8A', tint: '#D9EEF0', onTint: '#0E5A62' },
  { accent: '#5B3FA8', tint: '#E9E2F8', onTint: '#4E3497' },
];

const legendsPersonColors: readonly PersonColor[] = [
  { accent: '#F07CB1', tint: '#3A1828', onTint: '#F59AC3' },
  { accent: '#7DA2FF', tint: '#18264A', onTint: '#9DBBFF' },
  { accent: '#E8A34F', tint: '#3A2810', onTint: '#F2B865' },
  { accent: '#5FC9C9', tint: '#123236', onTint: '#7FD6DE' },
  { accent: '#B9A2FF', tint: '#272044', onTint: '#C4B2FF' },
];

export const classicTheme: Theme = {
  name: 'classic',
  dark: false,
  colors: classicColors,
  toneBackgrounds: classicToneBackgrounds,
  kindColors: classicKindColors,
  avatarTones: classicAvatarTones,
  personColors: classicPersonColors,
  selfPersonColor: { accent: '#0B5A33', tint: '#DCEFE3', onTint: '#0B5A33' },
};

export const legendsTheme: Theme = {
  name: 'legends',
  dark: true,
  colors: legendsColors,
  toneBackgrounds: legendsToneBackgrounds,
  kindColors: legendsKindColors,
  avatarTones: legendsAvatarTones,
  personColors: legendsPersonColors,
  selfPersonColor: { accent: '#5FD38D', tint: '#173322', onTint: '#7FE0A6' },
};

export const THEMES: Readonly<Record<ThemeName, Theme>> = {
  classic: classicTheme,
  legends: legendsTheme,
};

/** The avatar tone for a stable key (a person's id): the same key gets the same tone. */
export function avatarToneFor(theme: Theme, key: string): AvatarTone {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return theme.avatarTones[hash % theme.avatarTones.length] as AvatarTone;
}

/** The four elevation levels (ADR-008): a card, a raised card, a sheet and a sticky bottom bar. */
export type ElevationLevel = 'card' | 'raised' | 'sheet' | 'bar';

/** `#RRGGBB` at an opacity, as `#RRGGBBAA`. Internal: screens use tokens, not derived colours. */
function withAlpha(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 7)}${alpha}`.toUpperCase();
}

/** Shadow layers of each level on classic: [offset y, blur, opacity]; bars and sheets cast upwards. */
const SHADOW_LAYERS: Readonly<
  Record<ElevationLevel, readonly (readonly [number, number, number])[]>
> = {
  card: [
    [1, 2, 0.06],
    [2, 8, 0.04],
  ],
  raised: [
    [2, 4, 0.06],
    [8, 20, 0.08],
  ],
  sheet: [
    [-2, 12, 0.08],
    [-8, 32, 0.1],
  ],
  bar: [
    [-1, 0, 0.05],
    [-4, 16, 0.06],
  ],
};

const ELEVATION_SURFACE: Readonly<Record<ElevationLevel, keyof ThemeColors>> = {
  card: 'background',
  raised: 'elevated',
  sheet: 'sheet',
  bar: 'background',
};

/** Hairline colour of each level in a dark theme: higher levels get the stronger line. */
const ELEVATION_LINE: Readonly<Record<ElevationLevel, keyof ThemeColors>> = {
  card: 'border',
  raised: 'control',
  sheet: 'control',
  bar: 'border',
};

const elevationCache = new WeakMap<Theme, Map<ElevationLevel, ViewStyle>>();

/**
 * The style of an elevation level, with its surface colour: spread it first in a style and override
 * after it. A light theme gets a layered `boxShadow` in the `shadow` colour; a dark theme gets the
 * level's lighter surface and a hairline border instead (shadows do not show on black). The same
 * object is returned for the same theme and level.
 */
export function elevation(theme: Theme, level: ElevationLevel): ViewStyle {
  let levels = elevationCache.get(theme);
  if (!levels) {
    levels = new Map();
    elevationCache.set(theme, levels);
  }
  let style = levels.get(level);
  if (!style) {
    const { colors } = theme;
    const backgroundColor = colors[ELEVATION_SURFACE[level]];
    style = theme.dark
      ? {
          backgroundColor,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors[ELEVATION_LINE[level]],
        }
      : {
          backgroundColor,
          boxShadow: SHADOW_LAYERS[level]
            .map(
              ([y, blur, opacity]) => `0px ${y}px ${blur}px ${withAlpha(colors.shadow, opacity)}`,
            )
            .join(', '),
        };
    levels.set(level, style);
  }
  return style;
}

/**
 * The theme in use and the Legends mode switch. The default (no provider above, as in a component
 * rendered on its own in a test) is the classic theme with a switch that does nothing.
 */
export interface ThemeContextValue {
  theme: Theme;
  /** Whether Legends mode is on. */
  legends: boolean;
  setLegends(on: boolean): void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: classicTheme,
  legends: false,
  setLegends: () => undefined,
});

/** The theme in use: `const { colors } = useTheme()`. Re-renders when Legends mode is switched. */
export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/** The Legends mode switch (`src/ui/LegendsModeToggle`). */
export function useLegendsMode(): Pick<ThemeContextValue, 'legends' | 'setLegends'> {
  const { legends, setLegends } = useContext(ThemeContext);
  return { legends, setLegends };
}

type NamedStyles<T> = StyleSheet.NamedStyles<T>;

/**
 * A stylesheet that follows the theme. Declare it once at module level and read it in the
 * component: `const useStyles = makeStyles(({ colors }) => ({ box: { ... } }))`, then
 * `const styles = useStyles()`. Each theme's sheet is created once and reused, so switching
 * Legends mode re-renders with the other sheet at no per-render cost. No screen keeps a static
 * colour (`__tests__/theme.test.tsx` checks the sources).
 */
export function makeStyles<T extends NamedStyles<T> | NamedStyles<unknown>>(
  factory: (theme: Theme) => T & NamedStyles<unknown>,
): () => T {
  const sheets = new Map<ThemeName, T>();
  return function useStyles(): T {
    const theme = useTheme();
    let sheet = sheets.get(theme.name);
    if (!sheet) {
      sheet = StyleSheet.create(factory(theme));
      sheets.set(theme.name, sheet);
    }
    return sheet;
  };
}

export const spacing = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 } as const;

/**
 * Page layout (ADR-008): the side gutter of a screen, the gap between cards in a list and the gap
 * between sections.
 */
export const layout = { gutter: 20, cardGap: 12, sectionGap: 28 } as const;

/**
 * Corner radii. Cards (`lg`) and hero bands (`xl`) hold their content 16 pt in, so what sits inside
 * them uses a smaller radius (`sm`): nested corners stay roughly concentric. `pill` is a capsule.
 * `image` rounds artwork and photos; `sheet` is the top corners of a bottom sheet.
 */
export const radius = { sm: 10, md: 14, image: 16, lg: 20, xl: 24, sheet: 28, pill: 999 } as const;

/**
 * Continuous (squircle) corners where the platform draws them (iOS); elsewhere the plain radius.
 * Spread it next to a `borderRadius` on cards, tiles and bands; capsules stay round.
 */
export const continuousCorners = { borderCurve: 'continuous' } as const;

/** Font faces with their matching weight (see the header). */
export const fonts = {
  regular: { fontFamily: 'Archivo_400Regular', fontWeight: '400' as const },
  semibold: { fontFamily: 'Archivo_600SemiBold', fontWeight: '600' as const },
  bold: { fontFamily: 'Archivo_700Bold', fontWeight: '700' as const },
  extrabold: { fontFamily: 'Archivo_800ExtraBold', fontWeight: '800' as const },
  /** Titles and scores: the bold face at its normal width, written in sentence case. */
  display: { fontFamily: 'Archivo_700Bold', fontWeight: '700' as const },
  icon: { fontFamily: 'MaterialSymbols_400Regular', fontWeight: '400' as const },
} as const;

/** What the root layout loads before rendering (expo-font `useFonts`). */
export const FONT_ASSETS = {
  Archivo_400Regular,
  Archivo_600SemiBold,
  Archivo_700Bold,
  Archivo_800ExtraBold,
  MaterialSymbols_400Regular,
};

export const type = {
  /** Screen titles ("Discover", a team's name). Sentence case: nothing is set in capitals. */
  display: { ...fonts.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  /** Card and page titles. */
  title: { ...fonts.display, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  heading: { ...fonts.semibold, fontSize: 17, lineHeight: 24 },
  /** Section labels ("For you to know"): quiet, above the content they name. */
  eyebrow: { ...fonts.semibold, fontSize: 13, lineHeight: 18 },
  body: { ...fonts.regular, fontSize: 16, lineHeight: 23 },
  caption: { ...fonts.regular, fontSize: 14, lineHeight: 20 },
  // Tokens v2 (ADR-008): the rest of the scale, size/line height in pt.
  /** The big title at the top of a tab (34/41). */
  largeTitle: { ...fonts.display, fontSize: 34, lineHeight: 41, letterSpacing: -0.6 },
  /** A hero or sheet title (26/32). */
  title1: { ...fonts.display, fontSize: 26, lineHeight: 32, letterSpacing: -0.4 },
  /** A card title in a list (19/24). */
  title3: { ...fonts.semibold, fontSize: 19, lineHeight: 24, letterSpacing: -0.2 },
  /** Secondary lines next to body text (15/21). */
  callout: { ...fonts.regular, fontSize: 15, lineHeight: 21 },
  /** Notes under a control or a card (13/18). */
  footnote: { ...fonts.regular, fontSize: 13, lineHeight: 18 },
  /** Badges and tab labels only (12/16): never body text. */
  micro: { ...fonts.semibold, fontSize: 12, lineHeight: 16 },
} as const;

/**
 * Tabular (fixed-width) figures for times, scores, amounts and the pass, so digits do not shift as
 * they change: `[type.title1, tabularFigures]` or `tabular(type.title1)`.
 */
export const tabularFigures: TextStyle = { fontVariant: ['tabular-nums'] };

/** A type style with tabular figures. */
export function tabular<T extends TextStyle>(style: T): T & TextStyle {
  return { ...style, ...tabularFigures };
}

/** Minimum touch target (44 pt, iOS HIG; 48 dp on Android is met with padding). */
export const MIN_TOUCH_SIZE = 44;

/**
 * Button heights: `compact` 44 (the minimum target), `regular` 48 (the usual capsule) and `sticky`
 * 56 (the primary action in a bar pinned to the bottom of a screen).
 */
export const buttonHeight = { compact: 44, regular: 48, sticky: 56 } as const;

/**
 * Motion tokens (ADR-008; SPK-UX-010 asks for restrained animation). `src/ui/motion.tsx` reads
 * them; animated components get their durations through `useMotion()`, never from here, so reduced
 * motion always applies.
 *
 * - `durations` in milliseconds.
 * - `easings` as cubic-bezier control points (`Easing.bezier(...motionTokens.easings.standard)`):
 *   `standard` for moves on screen, `enter` for things arriving, `exit` for things leaving.
 * - `springs` as damping, stiffness and mass: `press` for a pressed control, `snappy` for small
 *   things settling (chips, toggles), `sheet` for a sheet snapping to a point.
 * - `pressScale`: what a pressed card or button shrinks to; not applied while motion is reduced.
 */
export const motionTokens = {
  durations: { instant: 0, fast: 120, base: 220, slow: 320 },
  easings: {
    standard: [0.2, 0, 0, 1],
    enter: [0, 0, 0, 1],
    exit: [0.3, 0, 1, 1],
  },
  springs: {
    press: { damping: 24, stiffness: 420, mass: 1 },
    snappy: { damping: 20, stiffness: 300, mass: 1 },
    sheet: { damping: 28, stiffness: 260, mass: 1 },
  },
  pressScale: 0.97,
} as const;

export type DurationToken = keyof typeof motionTokens.durations;

const NO_DURATIONS: Readonly<Record<DurationToken, number>> = {
  instant: 0,
  fast: 0,
  base: 0,
  slow: 0,
};

/** The durations to animate with: every one 0 while motion is reduced (SPK-UX-009). */
export function durationsFor(reduced: boolean): Readonly<Record<DurationToken, number>> {
  return reduced ? NO_DURATIONS : motionTokens.durations;
}
