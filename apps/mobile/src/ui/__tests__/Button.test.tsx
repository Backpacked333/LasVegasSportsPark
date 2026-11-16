/**
 * Button v2 (ADR-008 visual system v2; SPK-UX-009 role, name, state and targets; SPK-UX-010
 * restrained press motion): every variant and size, busy and disabled, wrapping labels, the press
 * scale only with motion on, and a light impact for a press that lands.
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { drawnStyle, renderUi, THEME_NAMES } from '../../testing/ui-actions';
import { Button, buttonLook, type ButtonVariant } from '../Button';
import { buttonHeight, legendsTheme, motionTokens, THEMES } from '../theme';

const VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'tonal',
  'text',
  'destructive',
  'onMedia',
  'lime',
  'ghost-dark',
];

describe('Button v2 (ADR-008, SPK-UX-009)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('SPK-UX-009: is a button named by its label, with disabled and busy state', async () => {
    const onPress = jest.fn();
    const { rerender } = await renderUi(<Button label="Save changes" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toBeEnabled();
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(<Button label="Save changes" onPress={onPress} disabled />);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));

    rerender(<Button label="Save changes" onPress={onPress} busy />);
    const busy = screen.getByRole('button', { name: 'Save changes' });
    expect(busy).toBeBusy();
    expect(busy).toBeDisabled();
    fireEvent.press(busy);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(VARIANTS)('the %s variant keeps a 44 pt target and a 48 pt capsule', async (variant) => {
    await renderUi(<Button label="Continue" variant={variant} onPress={() => undefined} />);
    const style = drawnStyle(screen.getByRole('button', { name: 'Continue' }));
    expect(style.minHeight).toBe(buttonHeight.regular);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.borderRadius).toBe(buttonHeight.regular / 2);
  });

  it('size lg is the 56 pt action of a sticky bar; md stays 48', async () => {
    const { rerender } = await renderUi(
      <Button label="Pay now" size="lg" block onPress={() => undefined} />,
    );
    let style = drawnStyle(screen.getByRole('button', { name: 'Pay now' }));
    expect(style.minHeight).toBe(buttonHeight.sticky);
    expect(style.borderRadius).toBe(buttonHeight.sticky / 2);
    expect(style.alignSelf).toBe('stretch');
    rerender(<Button label="Pay now" size="md" onPress={() => undefined} />);
    style = drawnStyle(screen.getByRole('button', { name: 'Pay now' }));
    expect(style.minHeight).toBe(buttonHeight.regular);
  });

  it('grows with a long label instead of truncating it', async () => {
    const label = 'Register both players for the autumn league and the holiday camp';
    await renderUi(<Button label={label} onPress={() => undefined} />);
    const style = drawnStyle(screen.getByRole('button', { name: label }));
    expect(style.height).toBeUndefined();
    expect(screen.getByText(label)).not.toHaveProp('numberOfLines');
  });

  it('the icon is decorative: the name is the label alone', async () => {
    await renderUi(<Button label="Add to calendar" icon="event" onPress={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Add to calendar' })).toBeOnTheScreen();
    expect(screen.queryByText('event')).toBeNull();
    expect(screen.getByText('event', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('a press that lands plays a light impact; a busy or disabled one plays nothing', async () => {
    const { haptics, rerender } = await renderUi(
      <Button label="Accept" onPress={() => undefined} />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Accept' }));
    expect(haptics.events).toEqual(['impact:light']);
    rerender(<Button label="Accept" onPress={() => undefined} busy />);
    fireEvent.press(screen.getByRole('button', { name: 'Accept' }));
    rerender(<Button label="Accept" onPress={() => undefined} haptic="none" />);
    fireEvent.press(screen.getByRole('button', { name: 'Accept' }));
    expect(haptics.events).toEqual(['impact:light']);
  });

  it('SPK-UX-009: with motion reduced a press darkens the fill and nothing moves', async () => {
    const { theme } = await renderUi(<Button label="Accept" onPress={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Accept' });
    fireEvent(button, 'pressIn');
    const style = drawnStyle(button);
    expect(style.backgroundColor).toBe(theme.colors.primaryPressed);
    expect(style.transform).toBeUndefined();
  });

  it('SPK-UX-010: with motion on a press springs to the press scale', async () => {
    jest.useFakeTimers();
    await renderUi(<Button label="Accept" onPress={() => undefined} />, { motion: 'full' });
    const button = screen.getByRole('button', { name: 'Accept' });
    fireEvent(button, 'pressIn');
    act(() => jest.advanceTimersByTime(1_000));
    const transform = (getAnimatedStyle(button) as { transform: { scale: number }[] }).transform;
    expect(transform[0]!.scale).toBeCloseTo(motionTokens.pressScale, 2);
  });

  it.each(THEME_NAMES)('draws every variant in %s colours from the theme', async (name) => {
    const theme = THEMES[name];
    await renderUi(
      <>
        {VARIANTS.map((variant) => (
          <Button key={variant} label={variant} variant={variant} onPress={() => undefined} />
        ))}
      </>,
      { theme: name },
    );
    for (const variant of VARIANTS) {
      const look = buttonLook(theme, variant);
      const style = drawnStyle(screen.getByRole('button', { name: variant }));
      expect(style.backgroundColor).toBe(look.box.backgroundColor);
      const label = drawnStyle(screen.getByText(variant));
      expect(label.color).toBe(look.text);
    }
  });

  it('maps the new variants to their tokens', () => {
    const { colors } = legendsTheme;
    expect(buttonLook(legendsTheme, 'tonal').text).toBe(colors.onTonal);
    expect(buttonLook(legendsTheme, 'destructive').box.backgroundColor).toBe(colors.danger);
    expect(buttonLook(legendsTheme, 'onMedia').box.backgroundColor).toBe(colors.scrimEnd);
    expect(buttonLook(legendsTheme, 'onMedia').text).toBe(colors.onMedia);
    expect(buttonLook(legendsTheme, 'text').text).toBe(colors.primary);
  });
});
