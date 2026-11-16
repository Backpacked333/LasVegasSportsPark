/**
 * Test helpers for the shared controls of the visual system v2 (ADR-008): render a component in
 * the app providers in either theme, with motion reduced (the default of every test) or on, and
 * read the style a control is drawn with.
 *
 *   const { haptics, theme } = await renderUi(<Button label="Save" onPress={save} />, { theme: 'legends' });
 *   expect(drawnStyle(screen.getByRole('button', { name: 'Save' })).minHeight).toBe(48);
 */
import { act, render } from '@testing-library/react-native';
import { createElement, type ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { MotionProvider } from '../ui/motion';
import { THEMES, type ThemeName } from '../ui/theme';
import { createTestApp } from './test-app';

export const THEME_NAMES: readonly ThemeName[] = ['classic', 'legends'];

export interface RenderUiOptions {
  theme?: ThemeName;
  /** `full` wraps the component in a `MotionProvider` with motion on; `reduced` (default) does not. */
  motion?: 'reduced' | 'full';
}

/**
 * Renders `ui` inside the test app (theme store, recorded haptics), optionally with motion on, and
 * waits for the providers' first reads (the stored session, connectivity) to land.
 */
export async function renderUi(
  ui: ReactElement,
  { theme = 'classic', motion = 'reduced' }: RenderUiOptions = {},
) {
  const app = createTestApp({ theme });
  const tree =
    motion === 'full' ? createElement(MotionProvider, { reduced: false, children: ui }) : ui;
  const view = render(tree, { wrapper: app.wrapper });
  await act(async () => {});
  return { ...view, app, haptics: app.haptics, theme: THEMES[theme] };
}

/** The flattened style a host element is drawn with (a function style is read unpressed). */
export function drawnStyle(element: { props: { style?: unknown } }): Record<string, unknown> {
  const style =
    typeof element.props.style === 'function'
      ? (element.props.style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : element.props.style;
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

/** Whether an element is hidden from VoiceOver and TalkBack (both platform props set). */
export function isHiddenFromScreenReaders(element: { props: Record<string, unknown> }): boolean {
  return (
    element.props.accessibilityElementsHidden === true &&
    element.props.importantForAccessibility === 'no-hide-descendants'
  );
}
