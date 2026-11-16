/**
 * Artwork (ADR-008 imagery, SPK-UX-009): always hidden from screen readers, on the skeleton fill,
 * and fading in only when motion is not reduced.
 */
import { screen } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { Text } from 'react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { Artwork } from '../Artwork';
import { MotionProvider } from '../motion';
import { classicTheme, legendsTheme } from '../theme';

const PHOTO = { uri: 'asset:/artwork/park.webp', width: 800, height: 500 };

describe('Artwork (ADR-008)', () => {
  it('SPK-UX-009: is never read by a screen reader, whatever the image shows', async () => {
    await renderSurface(
      <>
        <Artwork source={PHOTO} testID="art" />
        <Text>Fall league</Text>
      </>,
    );
    // Not found without hidden elements: the image and its frame are out of the accessibility tree.
    expect(screen.queryByTestId('art')).toBeNull();
    const frame = screen.getByTestId('art', { includeHiddenElements: true });
    expect(frame).toHaveProp('accessible', false);
    expect(frame).toHaveProp('accessibilityElementsHidden', true);
    expect(frame).toHaveProp('importantForAccessibility', 'no-hide-descendants');
    expect(screen.UNSAFE_getByType(Image).props.accessible).toBe(false);
    // What is read is the words next to it.
    expect(screen.getByText('Fall league')).toBeOnTheScreen();
    // No role, no name and no touch target: artwork is never a control.
    expect(screen.queryByRole('image')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'draws on the skeleton fill of the %s theme at its aspect ratio',
    async (name, theme) => {
      await renderSurface(<Artwork source={PHOTO} aspectRatio={4 / 3} testID="art" />, {
        theme: name,
      });
      expect(screen.getByTestId('art', { includeHiddenElements: true })).toHaveStyle({
        backgroundColor: theme.colors.skeleton,
        aspectRatio: 4 / 3,
      });
    },
  );

  it('passes a bundled source and its fit through to the image', async () => {
    await renderSurface(<Artwork source={7} contentFit="contain" />);
    const image = screen.UNSAFE_getByType(Image);
    expect(image.props.source).toBe(7);
    expect(image.props.contentFit).toBe('contain');
  });

  it('SPK-UX-009 reduced motion: appears at once without a provider, and fades in only with motion', async () => {
    const { rerender } = await renderSurface(<Artwork source={PHOTO} />);
    expect(screen.UNSAFE_getByType(Image).props.transition).toBe(0);
    rerender(
      <MotionProvider reduced>
        <Artwork source={PHOTO} />
      </MotionProvider>,
    );
    expect(screen.UNSAFE_getByType(Image).props.transition).toBe(0);
    rerender(
      <MotionProvider reduced={false}>
        <Artwork source={PHOTO} />
      </MotionProvider>,
    );
    expect(screen.UNSAFE_getByType(Image).props.transition).toBe(220);
  });
});
