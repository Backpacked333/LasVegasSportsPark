/**
 * Sheet (ADR-008 visual system v2; SPK-UX-009 focus into the sheet and back to its trigger, a
 * labelled 44 pt close button, motion only through useMotion). Under Jest the sheet renders
 * through React Native's `Modal`, so its content is queried like any other.
 */
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Modal, Text } from 'react-native';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { Sheet, SheetPresentationProvider, sheetPresentationFor } from '../Sheet';
import { MIN_TOUCH_SIZE, radius } from '../theme';

function DaySheet({
  open,
  onClose = () => undefined,
  returnFocusTo,
}: {
  open: boolean;
  onClose?: () => void;
  returnFocusTo?: { current: unknown };
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Choose a day"
      footer={<Text>Footer actions</Text>}
      returnFocusTo={returnFocusTo}
    >
      <Text>Saturday morning</Text>
    </Sheet>
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sheetPresentationFor (ADR-008)', () => {
  it('uses the bottom sheet on iOS and Android under its provider', () => {
    expect(sheetPresentationFor({ os: 'ios', provider: true, test: false })).toBe('native');
    expect(sheetPresentationFor({ os: 'android', provider: true, test: false })).toBe('native');
  });

  it('is the Modal on the web, under Jest and without a provider (the inert path)', () => {
    expect(sheetPresentationFor({ os: 'web', provider: true, test: false })).toBe('modal');
    expect(sheetPresentationFor({ os: 'ios', provider: true, test: true })).toBe('modal');
    expect(sheetPresentationFor({ os: 'ios', provider: false, test: false })).toBe('modal');
  });
});

describe('Sheet (ADR-008)', () => {
  it('renders nothing while closed and its title, content and footer while open', async () => {
    const { rerender } = await renderUi(<DaySheet open={false} />);
    expect(screen.queryByText('Saturday morning')).toBeNull();
    rerender(<DaySheet open />);
    expect(screen.getByRole('header', { name: 'Choose a day' })).toBeOnTheScreen();
    expect(screen.getByText('Saturday morning')).toBeOnTheScreen();
    expect(screen.getByText('Footer actions')).toBeOnTheScreen();
    expect(screen.getByTestId('sheet')).toHaveProp('accessibilityViewIsModal', true);
  });

  it('SPK-UX-009: a labelled 44 pt close button, the backdrop, back and escape all close it', async () => {
    const onClose = jest.fn();
    await renderUi(<DaySheet open onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(drawnStyle(close).minHeight).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    expect(drawnStyle(close).minWidth).toBeGreaterThanOrEqual(MIN_TOUCH_SIZE);
    fireEvent.press(close);
    // Behind the modal panel, so hidden from screen readers (they close it with the button).
    fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    fireEvent(screen.UNSAFE_getByType(Modal), 'requestClose');
    fireEvent(screen.getByTestId('sheet'), 'accessibilityEscape');
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('SPK-UX-009: focus moves to the title on open and back to the trigger on close', async () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
    const trigger = { current: { name: 'the trigger' } };
    const { rerender } = await renderUi(<DaySheet open={false} returnFocusTo={trigger} />);
    rerender(<DaySheet open returnFocusTo={trigger} />);
    await waitFor(() => expect(focus).toHaveBeenCalledWith(expect.anything(), 'focus'));
    const [title] = focus.mock.calls[0]!;
    expect(title).not.toBe(trigger.current);
    focus.mockClear();
    rerender(<DaySheet open={false} returnFocusTo={trigger} />);
    await waitFor(() => expect(focus).toHaveBeenCalledWith(trigger.current, 'focus'));
  });

  it('appears in place while motion is reduced, and fades with motion on', async () => {
    const { unmount } = await renderUi(<DaySheet open />);
    expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe('none');
    unmount();
    await renderUi(<DaySheet open />, { motion: 'full' });
    expect(screen.UNSAFE_getByType(Modal).props.animationType).toBe('fade');
  });

  it.each(THEME_NAMES)('draws on the sheet and backdrop tokens of the %s theme', async (name) => {
    const { theme } = await renderUi(<DaySheet open />, { theme: name });
    const panel = drawnStyle(screen.getByTestId('sheet'));
    expect(panel.backgroundColor).toBe(theme.colors.sheet);
    expect(panel.borderTopLeftRadius).toBe(radius.sheet);
    expect(
      drawnStyle(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }))
        .backgroundColor,
    ).toBe(theme.colors.backdrop);
    expect(screen.getByText('Choose a day')).toHaveStyle({ color: theme.colors.onSheet });
  });

  it('presents and dismisses the bottom sheet in the native presentation', async () => {
    const present = jest.spyOn(BottomSheetModal.prototype, 'present');
    const dismiss = jest.spyOn(BottomSheetModal.prototype, 'dismiss');
    const onClose = jest.fn();
    const { rerender } = await renderUi(
      <SheetPresentationProvider presentation="native">
        <DaySheet open onClose={onClose} />
      </SheetPresentationProvider>,
    );
    expect(present).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('header', { name: 'Choose a day' })).toBeOnTheScreen();
    expect(screen.UNSAFE_queryByType(Modal)).toBeNull();
    await act(async () => {
      rerender(
        <SheetPresentationProvider presentation="native">
          <DaySheet open={false} onClose={onClose} />
        </SheetPresentationProvider>,
      );
    });
    expect(dismiss).toHaveBeenCalled();
    // A dismiss the screen asked for is not reported back as the person closing it.
    expect(onClose).not.toHaveBeenCalled();
  });
});
