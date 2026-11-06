/**
 * Design tokens of the park visual system (SPK-UX-010: clear hierarchy, strong readability in busy
 * facilities, restrained animation), shared with the staff dashboard: night pitch, pitch green and
 * floodlight on desert sand, Archivo for everything, condensed uppercase for titles and scores.
 *
 * Colour supports a status but never carries it alone (SPK-UX-009): every tone also has a distinct
 * glyph and a text label (see StatusBadge). Text sizes are base sizes; the OS text-size setting
 * scales them (no `allowFontScaling={false}` anywhere).
 *
 * Fonts are bundled (`@expo-google-fonts/archivo`, `archivo-narrow`, `material-symbols`) and loaded
 * by the root layout before anything renders (`FONT_ASSETS`). Each font token names the face and
 * its matching weight, so a face that failed to load still falls back to a system font of the
 * same weight. The condensed display face is Archivo Narrow Bold: the static font packages carry
 * no condensed 800 instance of Archivo.
 */
import { Archivo_400Regular } from '@expo-google-fonts/archivo/400Regular';
import { Archivo_600SemiBold } from '@expo-google-fonts/archivo/600SemiBold';
import { Archivo_700Bold } from '@expo-google-fonts/archivo/700Bold';
import { Archivo_800ExtraBold } from '@expo-google-fonts/archivo/800ExtraBold';
import { ArchivoNarrow_700Bold } from '@expo-google-fonts/archivo-narrow/700Bold';
import { MaterialSymbols_400Regular } from '@expo-google-fonts/material-symbols/400Regular';

export const colors = {
  /** Screen background: desert sand. */
  page: '#F4F3EE',
  /** Card and control surface (white). */
  background: '#FFFFFF',
  /** Soft fill: pressed rows, highlighted table rows, empty bars. */
  surface: '#EEECE6',
  text: '#101814',
  textMuted: '#5A6660',
  /** Card borders. */
  border: '#E3E1D9',
  /** Dividers inside a card. */
  divider: '#EEECE6',
  /** Borders of controls (unselected chips, secondary buttons). */
  control: '#D9D6CC',
  primary: '#0B6B3A',
  primaryPressed: '#08532C',
  primaryText: '#FFFFFF',
  /** Night pitch: hero cards, the pass, the selected chip. */
  night: '#0C2219',
  nightRaised: '#122C21',
  nightLine: '#2F5444',
  nightMuted: '#9DB3A7',
  nightText: '#B9CBC1',
  /** Floodlight: the one accent; text on it is night. */
  floodlight: '#C6F36B',
  focus: '#1A4FD6',
  success: '#0B6B3A',
  warning: '#8A5300',
  /** Border of a warning notice (changes affecting you, the offline banner). */
  warningBorder: '#F0D9A6',
  danger: '#B3261E',
  info: '#1A4FD6',
  neutral: '#4A5651',
  pending: '#5B3FA8',
} as const;

/** Tint behind each status tone (pills, notices, icon tiles); the tone colour is the text. */
export const toneBackgrounds = {
  success: '#E3F1E8',
  warning: '#FDF0D5',
  danger: '#FBE3E0',
  info: '#E4EBFD',
  neutral: '#EEF0EE',
  pending: '#EEE8FA',
} as const;

/** Activity kinds (schedule stripes, list tiles): a colour always next to the kind's name. */
export const kindColors = {
  league: '#0B6B3A',
  program: '#2D5BD8',
  rental: '#B07A12',
  party: '#B0306B',
  basketball: '#C4541C',
  dropin: '#5A6660',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = { sm: 10, md: 14, lg: 18, xl: 22, pill: 999 } as const;

/** Font faces with their matching weight (see the header). */
export const fonts = {
  regular: { fontFamily: 'Archivo_400Regular', fontWeight: '400' as const },
  semibold: { fontFamily: 'Archivo_600SemiBold', fontWeight: '600' as const },
  bold: { fontFamily: 'Archivo_700Bold', fontWeight: '700' as const },
  extrabold: { fontFamily: 'Archivo_800ExtraBold', fontWeight: '800' as const },
  /** Condensed, for titles and scores; always uppercase. */
  display: { fontFamily: 'ArchivoNarrow_700Bold', fontWeight: '700' as const },
  icon: { fontFamily: 'MaterialSymbols_400Regular', fontWeight: '400' as const },
} as const;

/** What the root layout loads before rendering (expo-font `useFonts`). */
export const FONT_ASSETS = {
  Archivo_400Regular,
  Archivo_600SemiBold,
  Archivo_700Bold,
  Archivo_800ExtraBold,
  ArchivoNarrow_700Bold,
  MaterialSymbols_400Regular,
};

export const type = {
  /** Screen titles ("DISCOVER", a team's name). */
  display: {
    ...fonts.display,
    fontSize: 34,
    lineHeight: 36,
    textTransform: 'uppercase' as const,
  },
  /** Card and page titles. */
  title: {
    ...fonts.display,
    fontSize: 26,
    lineHeight: 28,
    textTransform: 'uppercase' as const,
  },
  heading: { ...fonts.bold, fontSize: 18, lineHeight: 24 },
  /** Section labels ("FOR YOU TO KNOW"). */
  eyebrow: {
    ...fonts.extrabold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.4,
    textTransform: 'uppercase' as const,
  },
  body: { ...fonts.regular, fontSize: 16, lineHeight: 22 },
  caption: { ...fonts.regular, fontSize: 14, lineHeight: 20 },
} as const;

/** Minimum touch target (44 pt, iOS HIG; 48 dp on Android is met with padding). */
export const MIN_TOUCH_SIZE = 44;
