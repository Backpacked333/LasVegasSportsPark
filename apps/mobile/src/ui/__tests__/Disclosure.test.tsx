/**
 * Disclosure (ADR-008, SPK-UX-009): a fold whose heading is a button with an expanded state.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { LayoutAnimation, StyleSheet, Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { Disclosure } from '../Disclosure';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme } from '../theme';

describe('Disclosure (ADR-008)', () => {
  it('SPK-UX-009: is a button named by its title that reports whether it is open', async () => {
    await renderSurface(
      <Disclosure title="What to bring">
        <Text>Shin guards and water.</Text>
      </Disclosure>,
    );
    const heading = screen.getByRole('button', { name: 'What to bring' });
    expect(heading).toBeCollapsed();
    expect(screen.queryByText('Shin guards and water.')).toBeNull();

    fireEvent.press(heading);
    expect(screen.getByRole('button', { name: 'What to bring' })).toBeExpanded();
    expect(screen.getByText('Shin guards and water.')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'What to bring' }));
    expect(screen.getByRole('button', { name: 'What to bring' })).toBeCollapsed();
    expect(screen.queryByText('Shin guards and water.')).toBeNull();
  });

  it('can start open, or be controlled', async () => {
    const onToggle = jest.fn();
    const { rerender } = await renderSurface(
      <Disclosure title="Rules" defaultExpanded>
        <Text>No cleats on the turf.</Text>
      </Disclosure>,
    );
    expect(screen.getByText('No cleats on the turf.')).toBeOnTheScreen();
    rerender(
      <Disclosure title="Rules" expanded={false} onToggle={onToggle}>
        <Text>No cleats on the turf.</Text>
      </Disclosure>,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Rules' }));
    expect(onToggle).toHaveBeenCalledWith(true);
    // Controlled: it stays as its owner says.
    expect(screen.getByRole('button', { name: 'Rules' })).toBeCollapsed();
  });

  it('SPK-UX-009: the heading is at least 44 pt tall, in both sizes', async () => {
    await renderSurface(
      <>
        <Disclosure title="Large">
          <Text>One</Text>
        </Disclosure>
        <Disclosure title="Small" size="sm">
          <Text>Two</Text>
        </Disclosure>
      </>,
    );
    for (const name of ['Large', 'Small']) {
      const style = StyleSheet.flatten(screen.getByRole('button', { name }).props.style) as {
        minHeight: number;
      };
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('draws its title in the text colours of the %s theme', async (name, theme) => {
    await renderSurface(
      <>
        <Disclosure title="Large">
          <Text>One</Text>
        </Disclosure>
        <Disclosure title="Small" size="sm">
          <Text>Two</Text>
        </Disclosure>
      </>,
      { theme: name },
    );
    expect(screen.getByText('Large')).toHaveStyle({ color: theme.colors.text });
    expect(screen.getByText('Small')).toHaveStyle({ color: theme.colors.textMuted });
  });

  it('SPK-UX-009 reduced motion: opens at once, and animates the layout only when motion is allowed', async () => {
    const configure = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation(() => {});
    const fold = (
      <Disclosure title="More">
        <Text>Inside</Text>
      </Disclosure>
    );
    const { rerender } = await renderSurface(fold);
    fireEvent.press(screen.getByRole('button', { name: 'More' }));
    expect(configure).not.toHaveBeenCalled();
    expect(screen.getByText('Inside')).toBeOnTheScreen();

    rerender(<MotionProvider reduced={false}>{fold}</MotionProvider>);
    fireEvent.press(screen.getByRole('button', { name: 'More' }));
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0]?.[0]).toMatchObject({ duration: 220 });
    configure.mockRestore();
  });
});
