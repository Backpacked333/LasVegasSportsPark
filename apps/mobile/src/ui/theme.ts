/**
 * Design tokens of the park visual system (SPK-UX-010: clear hierarchy, strong readability in busy
 * facilities, restrained animation), shared with the staff dashboard, in two themes with the same
 * token names: classic (a calm warm white, white cards, pitch green as the accent) and Legends
 * mode (neutral black with one gold accent). Archivo for everything, at one width and in sentence
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
 */
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_700Bold } from '@expo-google-fonts/archivo/700Bold';
import { Archivo_800ExtraBold } from '@expo-google-fonts/archivo/800ExtraBold';
import { MaterialSymbols_400Regular } from '@expo-google-fonts/material-symbols/400Regular';
import { createContext, useContext } from 'react';
import { StyleSheet } from 'react-native';

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
} as const;

/** Every colour token of a theme; the two themes carry the same names. */
export type ThemeColors = { readonly [K in keyof typeof classicColors]: string };

/**
 * Legends mode: a dark theme with one gold accent (the same palette as the staff dashboard's
 * Legends mode). Pairings checked for contrast (SPK-UX-009; see __tests__/theme.test.tsx): body
 * text on every surface 4.5:1 or more, the label on a gold button 4.5:1 or more.
 */
const legendsColors: ThemeColors = {
  page: '#0A0A0B',
  background: '#131314',
  surface: '#1D1D20',
  text: '#F5F5F7',
  textMuted: '#A6A6AD',
  border: '#242427',
  divider: '#1C1C1F',
  control: '#37373C',
  primary: '#E8B84A',
  primaryPressed: '#D4A337',
  primaryText: '#17120A',
  night: '#000000',
  nightRaised: '#101011',
  nightLine: '#34343A',
  nightMuted: '#A1A1A8',
  nightText: '#C7C7CC',
  onNight: '#F5F5F7',
  onNightBody: '#D6D6DB',
  pitch: '#211C0E',
  floodlight: '#F0C75A',
  onFloodlight: '#000000',
  tabActive: '#F0C75A',
  chipSelected: '#E8B84A',
  onChipSelected: '#17120A',
  chipSelectedIcon: '#17120A',
  focus: '#F0C75A',
  success: '#5FD38D',
  warning: '#FF9F4A',
  warningBorder: '#5A3A16',
  danger: '#FF7B72',
  info: '#7DB2FF',
  neutral: '#B4B4BB',
  pending: '#B9A2FF',
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
  success: '#14291D',
  warning: '#33210F',
  danger: '#361816',
  info: '#152238',
  neutral: '#222225',
  pending: '#221B38',
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
  league: '#5FD38D',
  program: '#7DA2FF',
  rental: '#E8A34F',
  party: '#F07CB1',
  basketball: '#FF8A5C',
  dropin: '#A6A6AD',
};

export type ThemeName = 'classic' | 'legends';

/** Everything that changes with the theme. Spacing, radii and type are the same in both. */
export interface Theme {
  readonly name: ThemeName;
  /** A dark theme: light status bar content, dark keyboards and system sheets. */
  readonly dark: boolean;
  readonly colors: ThemeColors;
  readonly toneBackgrounds: ThemeToneBackgrounds;
  readonly kindColors: ThemeKindColors;
}

export const classicTheme: Theme = {
  name: 'classic',
  dark: false,
  colors: classicColors,
  toneBackgrounds: classicToneBackgrounds,
  kindColors: classicKindColors,
};

export const legendsTheme: Theme = {
  name: 'legends',
  dark: true,
  colors: legendsColors,
  toneBackgrounds: legendsToneBackgrounds,
  kindColors: legendsKindColors,
};

export const THEMES: Readonly<Record<ThemeName, Theme>> = {
  classic: classicTheme,
  legends: legendsTheme,
};

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

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/**
 * Corner radii. Cards (`lg`) and hero bands (`xl`) hold their content 16 pt in, so what sits inside
 * them uses a smaller radius (`sm`): nested corners stay roughly concentric. `pill` is a capsule.
 */
export const radius = { sm: 10, md: 14, lg: 20, xl: 24, pill: 999 } as const;

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
} as const;

/** Minimum touch target (44 pt, iOS HIG; 48 dp on Android is met with padding). */
export const MIN_TOUCH_SIZE = 44;
