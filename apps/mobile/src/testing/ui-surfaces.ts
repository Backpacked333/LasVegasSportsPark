/**
 * Test mechanics of the surface components (ADR-008), in one place so screen tests say what the
 * person does, not how a component is built:
 *
 * - `openSupportDetails(scope)`: opens every closed "Details for support" fold in `scope` (the
 *   screen, or `within(element)`), where decision identifiers, owners, error codes and references
 *   live (PA-11, SPK-UX-011 **Proposed**). Waits for the fold to appear, as `findBy*` does.
 * - `pullToRefresh(screen)`: pulls the screen's content down, as a person does to refresh.
 * - `pressedStyle(screen, name)`: the flattened style a pressable with that accessible label has
 *   while pressed (press feedback cannot be held down in a test).
 * - `renderSurface(ui, { theme })`: renders a component inside the test app (`createTestApp`) in
 *   the classic or the Legends theme, once its providers have settled. No `MotionProvider`, so
 *   motion is reduced unless the test adds one.
 * - `codesOutsideSupport(screen)`: the rendered text that shows an internal code outside the
 *   "Details for support" fold (PA-11); a screen test expects it to be empty.
 */
import { act, fireEvent, render, type screen as rntlScreen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { RefreshControl, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { ILLUSTRATION_NAMES, illustrations, type IllustrationName } from '../artwork/manifest';
import { BANNED_CUSTOMER_CODES } from '../copy/vocabulary';
import { Artwork } from '../ui/Artwork';
import { SUPPORT_DETAILS_TITLE } from '../ui/SupportDetails';
import type { ThemeName } from '../ui/theme';
import { createTestApp, type TestAppOptions } from './test-app';

export async function renderSurface(
  ui: ReactElement,
  { theme = 'classic', ...options }: TestAppOptions & { theme?: ThemeName } = {},
) {
  const app = createTestApp({ ...options, theme });
  const view = render(ui, { wrapper: app.wrapper });
  // The providers read the session and the connectivity once; let those answers land.
  await act(async () => undefined);
  return { ...view, app };
}

type Queries = Pick<typeof rntlScreen, 'findAllByRole'>;

export async function openSupportDetails(scope: Queries): Promise<void> {
  const folds = await scope.findAllByRole('button', { name: SUPPORT_DETAILS_TITLE });
  for (const fold of folds) {
    const state = fold.props.accessibilityState as { expanded?: boolean } | undefined;
    if (state?.expanded !== true) fireEvent.press(fold);
  }
}

/**
 * Calls the refresh handler of the screen's pull-to-refresh control. Fails when the screen has
 * none, or more than one (say which by rendering less).
 */
export async function pullToRefresh(
  scope: Pick<typeof rntlScreen, 'UNSAFE_getAllByType'>,
): Promise<void> {
  const controls = scope.UNSAFE_getAllByType(RefreshControl);
  if (controls.length !== 1) {
    throw new Error(`Expected one pull-to-refresh control, found ${controls.length}.`);
  }
  const onRefresh = (controls[0]?.props as { onRefresh?: () => void }).onRefresh;
  if (!onRefresh) throw new Error('The pull-to-refresh control has no refresh handler.');
  await act(async () => {
    onRefresh();
  });
}

type PressableStyle = (state: { pressed: boolean }) => StyleProp<ViewStyle>;

/** The style of the pressable labelled `name` while pressed (`pressed: true`), flattened. */
export function pressedStyle(
  scope: Pick<typeof rntlScreen, 'UNSAFE_getAllByProps'>,
  name: string,
  pressed = true,
): ViewStyle {
  const pressable = scope
    .UNSAFE_getAllByProps({ accessibilityLabel: name })
    .find((instance) => typeof instance.props.style === 'function');
  if (!pressable) throw new Error(`No pressable named "${name}" with a pressed style.`);
  return StyleSheet.flatten((pressable.props.style as PressableStyle)({ pressed })) ?? {};
}

type JsonNode = { type: string; props: Record<string, unknown>; children: JsonChild[] | null };
type JsonChild = JsonNode | string;

/**
 * PA-11, SPK-UX-011 (**Proposed**): every piece of text the rendered screen shows or speaks (text,
 * accessibility labels and values) that carries an internal code (`SCR-`, `SPK-`, `DEC-`, `POL-`,
 * `PA-` with a digit, `§`), while the "Details for support" folds are closed. A closed fold renders
 * nothing inside it, so whatever this finds is outside the fold. The copy guard reads the source;
 * this catches text built at run time from the API's answers (policy defaults, reasons).
 */
export function codesOutsideSupport(scope: Pick<typeof rntlScreen, 'toJSON'>): string[] {
  const found: string[] = [];
  const check = (text: unknown) => {
    if (typeof text !== 'string' || text === '') return;
    if (BANNED_CUSTOMER_CODES.some((banned) => banned.pattern.test(text))) found.push(text);
  };
  const walk = (node: JsonChild | JsonChild[] | null) => {
    if (node === null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'string') {
      check(node);
      return;
    }
    check(node.props.accessibilityLabel);
    check((node.props.accessibilityValue as { text?: unknown } | undefined)?.text);
    walk(node.children);
  };
  walk(scope.toJSON() as JsonChild | JsonChild[] | null);
  return found;
}

/**
 * ADR-008: the names of the illustrations (`src/artwork/manifest.ts`) drawn on the screen, in
 * order, so an empty state's test can say which picture it shows.
 */
export function illustrationsOnScreen(
  scope: Pick<typeof rntlScreen, 'UNSAFE_queryAllByType'>,
): IllustrationName[] {
  const bySource = new Map<unknown, IllustrationName>(
    ILLUSTRATION_NAMES.map((name) => [illustrations[name], name]),
  );
  return scope
    .UNSAFE_queryAllByType(Artwork)
    .map((a) => bySource.get((a.props as { source?: unknown }).source))
    .filter((name): name is IllustrationName => name !== undefined);
}
