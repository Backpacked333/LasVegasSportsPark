/**
 * Decorative icon from the bundled Material Symbols font (ligature name, e.g. "home",
 * "qr_code_2"). Always hidden from VoiceOver and TalkBack: the control or text next to it carries
 * the meaning (SPK-UX-009), so an icon never stands alone for a status or an action. It scales
 * with the OS text size, up to a limit so it never crowds out the words beside it.
 */
import { StyleSheet, Text, type ColorValue } from 'react-native';
import { colors, fonts } from './theme';

export interface IconProps {
  name: string;
  size?: number;
  color?: ColorValue;
  testID?: string;
}

export function Icon({ name, size = 22, color = colors.text, testID }: IconProps) {
  return (
    <Text
      style={[styles.icon, { fontSize: size, lineHeight: size + 2, color }]}
      maxFontSizeMultiplier={1.4}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      {name}
    </Text>
  );
}

const styles = StyleSheet.create({
  icon: { ...fonts.icon, includeFontPadding: false },
});
