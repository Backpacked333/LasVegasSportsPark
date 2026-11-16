/**
 * Skeletons (ADR-008 visual system v2; SPK-UX-008 loading keeps the page's shape; SPK-UX-009
 * hidden from screen readers, static with reduced motion): shapes in the skeleton tokens, a
 * shimmer only with motion on.
 */
import { render, screen } from '@testing-library/react-native';
import {
  drawnStyle,
  isHiddenFromScreenReaders,
  renderUi,
  THEME_NAMES,
} from '../../testing/ui-actions';
import { Skeleton, SkeletonCard, SkeletonGroup, skeletonShapeStyle } from '../Skeleton';
import { radius, THEMES } from '../theme';

describe('Skeleton (ADR-008)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('SPK-UX-009: every shape and the card preset are hidden from screen readers', () => {
    render(
      <>
        <Skeleton shape="line" testID="line" />
        <Skeleton shape="block" testID="block" />
        <Skeleton shape="circle" testID="circle" />
        <SkeletonCard testID="card" />
        <SkeletonGroup testID="group">
          <Skeleton />
        </SkeletonGroup>
      </>,
    );
    for (const id of ['line', 'block', 'circle', 'card', 'group']) {
      const element = screen.getByTestId(id, { includeHiddenElements: true });
      expect(isHiddenFromScreenReaders(element)).toBe(true);
      // Not visible to a screen reader query at all.
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('is not a control: no role and no touch target', () => {
    render(<SkeletonCard />);
    expect(screen.queryByRole('button', { includeHiddenElements: true })).toBeNull();
  });

  it('draws a line, a block and a circle in their sizes and corners', () => {
    expect(skeletonShapeStyle({ shape: 'line' })).toEqual({
      width: '100%',
      height: 14,
      borderRadius: 7,
    });
    expect(skeletonShapeStyle({ shape: 'line', width: '60%', height: 20 })).toMatchObject({
      width: '60%',
      borderRadius: 10,
    });
    expect(skeletonShapeStyle({ shape: 'block', height: 90 })).toMatchObject({
      height: 90,
      borderRadius: radius.image,
    });
    expect(skeletonShapeStyle({ shape: 'circle', size: 48 })).toEqual({
      width: 48,
      height: 48,
      borderRadius: 24,
    });
  });

  it('SPK-UX-009: is static with motion reduced (no shimmer drawn)', async () => {
    await renderUi(<Skeleton testID="line" />);
    expect(screen.queryByTestId('skeleton-shimmer', { includeHiddenElements: true })).toBeNull();
  });

  it('shimmers with motion on', async () => {
    jest.useFakeTimers();
    const { unmount } = await renderUi(<Skeleton testID="line" />, { motion: 'full' });
    expect(
      screen.getByTestId('skeleton-shimmer', { includeHiddenElements: true }),
    ).toBeOnTheScreen();
    unmount();
  });

  it.each(THEME_NAMES)('draws the fill and the highlight in %s skeleton tokens', async (name) => {
    jest.useFakeTimers();
    const { colors } = THEMES[name];
    const { unmount } = await renderUi(<Skeleton shape="block" testID="block" />, {
      theme: name,
      motion: 'full',
    });
    const block = screen.getByTestId('block', { includeHiddenElements: true });
    expect(drawnStyle(block).backgroundColor).toBe(colors.skeleton);
    const shimmer = screen.getByTestId('skeleton-shimmer', { includeHiddenElements: true });
    expect(drawnStyle(shimmer).backgroundColor).toBe(colors.skeletonHighlight);
    unmount();
  });
});
