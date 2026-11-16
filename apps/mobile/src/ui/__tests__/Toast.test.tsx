/**
 * Toasts (ADR-008 visual system v2; SPK-UX-009 announced, never colour alone; SPK-UX-010
 * restrained motion): low-stakes successes only, announced, dismissed by a timer, and a no-op
 * without a provider.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Pressable, Text } from 'react-native';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { THEMES } from '../theme';
import { TOAST_DURATION_MS, ToastProvider, useToast, type ToastOptions } from '../Toast';

function Trigger({ toast, label = 'Save' }: { toast: ToastOptions; label?: string }) {
  const { show } = useToast();
  return (
    <Pressable accessibilityRole="button" onPress={() => show(toast)}>
      <Text>{label}</Text>
    </Pressable>
  );
}

const withProvider = (ui: React.ReactElement) => <ToastProvider>{ui}</ToastProvider>;

describe('Toast (ADR-008)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('without a ToastProvider, show does nothing (screen tests need none)', () => {
    render(<Trigger toast={{ message: 'Saved' }} />);
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('SPK-UX-009: shows the message in a polite live region and posts it to VoiceOver', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions');
    await renderUi(withProvider(<Trigger toast={{ message: 'Added to your calendar' }} />));
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Added to your calendar')).toBeOnTheScreen();
    expect(screen.getByTestId('toast')).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(announce).toHaveBeenCalledWith('Added to your calendar', { queue: true });
  });

  it('is not a control: no button or touch target of its own', async () => {
    await renderUi(withProvider(<Trigger toast={{ message: 'Link copied' }} />));
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('dismisses itself after its duration, on the timer', async () => {
    await renderUi(withProvider(<Trigger toast={{ message: 'Saved' }} />));
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(screen.getByText('Saved')).toBeOnTheScreen();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('a newer toast replaces the one on screen and restarts the timer', async () => {
    await renderUi(
      withProvider(
        <>
          <Trigger toast={{ message: 'First' }} label="One" />
          <Trigger toast={{ message: 'Second', tone: 'info' }} label="Two" />
        </>,
      ),
    );
    fireEvent.press(screen.getByRole('button', { name: 'One' }));
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS - 1_000));
    fireEvent.press(screen.getByRole('button', { name: 'Two' }));
    expect(screen.queryByText('First')).toBeNull();
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(screen.getByText('Second')).toBeOnTheScreen();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('SPK-UX-009: each tone has its own glyph, hidden from screen readers', async () => {
    await renderUi(
      withProvider(
        <>
          <Trigger toast={{ message: 'Done' }} label="One" />
          <Trigger toast={{ message: 'Heads up', tone: 'info' }} label="Two" />
        </>,
      ),
    );
    fireEvent.press(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByText('check_circle', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByText('check_circle')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Two' }));
    expect(screen.getByText('info', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('ignores an empty message', async () => {
    await renderUi(withProvider(<Trigger toast={{ message: '  ' }} />));
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('with motion on it still appears, is announced and goes after its duration', async () => {
    await renderUi(withProvider(<Trigger toast={{ message: 'Saved' }} />), { motion: 'full' });
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Saved')).toBeOnTheScreen();
    act(() => jest.advanceTimersByTime(TOAST_DURATION_MS + 1_000));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it.each(THEME_NAMES)('draws the toast in the %s toast tokens', async (name) => {
    const { colors } = THEMES[name];
    await renderUi(withProvider(<Trigger toast={{ message: 'Saved' }} />), { theme: name });
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(drawnStyle(screen.getByTestId('toast')).backgroundColor).toBe(colors.toast);
    expect(drawnStyle(screen.getByText('Saved')).color).toBe(colors.onToast);
  });
});
