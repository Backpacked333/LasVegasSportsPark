/**
 * What every text field shares, whichever feature draws it: the field shows that it has the focus
 * (its border takes the focus colour; an error style placed after it still wins), and the caret,
 * the placeholder and the keyboard follow the theme in use, so a dark page never opens a light
 * keyboard. The label, hint and error stay the field's own (SPK-UX-009).
 */
import { useState } from 'react';
import { useTheme } from './theme';

export function useInputChrome() {
  const { colors, dark } = useTheme();
  const [focused, setFocused] = useState(false);
  return {
    /** Spread on the `TextInput`. */
    props: {
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      selectionColor: colors.primary,
      placeholderTextColor: colors.textMuted,
      keyboardAppearance: dark ? ('dark' as const) : ('light' as const),
    },
    /** Put right after the field's base style. */
    focusStyle: focused ? { borderColor: colors.focus } : null,
  };
}
