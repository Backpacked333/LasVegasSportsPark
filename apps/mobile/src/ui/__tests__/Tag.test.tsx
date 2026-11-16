/**
 * Tag (ADR-008, SPK-UX-009): a short label read as text, in neutral, tonal and on-media tones.
 */
import { screen } from '@testing-library/react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import { Tag } from '../Tag';
import { classicTheme, legendsTheme } from '../theme';

describe('Tag (ADR-008)', () => {
  it('SPK-UX-009: is text named by its label, with a decorative icon, and no touch target', async () => {
    await renderSurface(<Tag label="Indoor" icon="home" />);
    const tag = screen.getByLabelText('Indoor');
    expect(tag).toHaveProp('accessibilityRole', 'text');
    expect(tag).toHaveProp('accessible', true);
    expect(screen.queryByText('home')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)('takes its tone colours from the %s theme', async (name, theme) => {
    await renderSurface(
      <>
        <Tag label="Ages 9 to 10" />
        <Tag label="New" tone="tonal" />
        <Tag label="Saturdays" tone="onMedia" />
      </>,
      { theme: name },
    );
    expect(screen.getByLabelText('Ages 9 to 10')).toHaveStyle({
      backgroundColor: theme.colors.surface,
    });
    expect(screen.getByText('Ages 9 to 10')).toHaveStyle({ color: theme.colors.text });
    expect(screen.getByLabelText('New')).toHaveStyle({
      backgroundColor: theme.colors.tonal,
    });
    expect(screen.getByText('New')).toHaveStyle({ color: theme.colors.onTonal });
    // Over artwork the tag sits on the scrim, whose contrast the theme test computes.
    expect(screen.getByLabelText('Saturdays')).toHaveStyle({
      backgroundColor: theme.colors.scrimEnd,
    });
    expect(screen.getByText('Saturdays')).toHaveStyle({ color: theme.colors.onMedia });
  });

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<Tag label="Indoor" />);
    const still = screen.getByLabelText('Indoor').props.style;
    rerender(
      <MotionProvider reduced={false}>
        <Tag label="Indoor" />
      </MotionProvider>,
    );
    expect(screen.getByLabelText('Indoor').props.style).toEqual(still);
  });
});
