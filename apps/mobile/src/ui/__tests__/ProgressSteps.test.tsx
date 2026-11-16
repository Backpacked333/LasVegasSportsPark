/**
 * ProgressSteps (ADR-008, SPK-UX-009): done, current and upcoming steps, read as "Step 2 of 5,
 * Options".
 */
import { screen } from '@testing-library/react-native';
import { renderSurface } from '../../testing/ui-surfaces';
import { MotionProvider } from '../motion';
import { ProgressSteps, progressStepsLabel, stepStates } from '../ProgressSteps';
import { classicTheme, legendsTheme } from '../theme';

const STEPS = ['Who', 'Options', 'Forms', 'Review', 'Pay'];

describe('ProgressSteps (ADR-008)', () => {
  it('marks the steps before the current one done and the rest upcoming', () => {
    expect(stepStates(5, 1)).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
    expect(stepStates(3, 2)).toEqual(['done', 'done', 'current']);
    expect(progressStepsLabel(STEPS, 1)).toBe('Step 2 of 5, Options');
    // Out of range is clamped, never "Step 7 of 5".
    expect(progressStepsLabel(STEPS, 9)).toBe('Step 5 of 5, Pay');
  });

  it('SPK-UX-009: is one element named "Step 2 of 5, Options", with the words on screen too', async () => {
    await renderSurface(<ProgressSteps steps={STEPS} current={1} />);
    expect(screen.getByLabelText('Step 2 of 5, Options')).toBeOnTheScreen();
    expect(screen.getByText('Step 2 of 5')).toBeOnTheScreen();
    expect(screen.getByText('Options')).toBeOnTheScreen();
    // Not a control: nothing to press, so no touch target.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['classic', classicTheme],
    ['legends', legendsTheme],
  ] as const)(
    'draws each state differently in the %s theme, not by colour alone',
    async (name, theme) => {
      await renderSurface(<ProgressSteps steps={STEPS} current={2} testID="steps" />, {
        theme: name,
      });
      const done = screen.getAllByTestId('steps-done', { includeHiddenElements: true });
      const current = screen.getAllByTestId('steps-current', { includeHiddenElements: true });
      const upcoming = screen.getAllByTestId('steps-upcoming', { includeHiddenElements: true });
      expect([done.length, current.length, upcoming.length]).toEqual([2, 1, 2]);
      for (const step of done) expect(step).toHaveStyle({ backgroundColor: theme.colors.primary });
      expect(current[0]).toHaveStyle({ backgroundColor: theme.colors.primary });
      for (const step of upcoming) {
        expect(step).toHaveStyle({ backgroundColor: theme.colors.control, height: 6 });
      }
      // Done steps carry a check; the current one does not.
      expect(screen.getAllByText('check', { includeHiddenElements: true })).toHaveLength(2);
    },
  );

  it('SPK-UX-009 reduced motion: is static with or without motion', async () => {
    const { rerender } = await renderSurface(<ProgressSteps steps={STEPS} current={0} />);
    expect(screen.getByLabelText('Step 1 of 5, Who')).toBeOnTheScreen();
    rerender(
      <MotionProvider reduced={false}>
        <ProgressSteps steps={STEPS} current={3} />
      </MotionProvider>,
    );
    expect(screen.getByLabelText('Step 4 of 5, Review')).toBeOnTheScreen();
  });
});
