/**
 * SPK-UX-006 understandable error states, §5.11: a screen that fails while rendering is contained
 * and reported; errors nothing caught are reported and still reach React Native's own handler.
 */
import { ApiError } from '@sportspark/api-client';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { installGlobalCrashHandler, MemoryCrashReporter } from '../../providers/crash-report';
import { ErrorBoundary } from '../ErrorBoundary';

const NOW = new Date('2026-11-09T12:00:00Z');

function Exploding({ when }: { when: () => boolean }) {
  if (when()) {
    throw new ApiError({
      kind: 'api',
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      nextAction: 'retry_later',
      correlationId: 'corr-mobile-1234',
    });
  }
  return <Text>Home</Text>;
}

describe('ErrorBoundary (SPK-UX-006)', () => {
  it('SPK-UX-006: a render failure shows what happened, the support reference and a retry; it is reported once', () => {
    const reporter = new MemoryCrashReporter();
    let broken = true;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <ErrorBoundary reporter={reporter} now={() => NOW}>
          <Exploding when={() => broken} />
        </ErrorBoundary>,
      );
      expect(screen.getByText('Something went wrong')).toBeTruthy();
      expect(screen.getByText('Reference for support: corr-mobile-1234')).toBeTruthy();
      expect(reporter.reports).toEqual([
        {
          source: 'render',
          message: 'INTERNAL_ERROR: An unexpected error occurred.',
          correlationId: 'corr-mobile-1234',
          fatal: false,
          at: NOW,
        },
      ]);
      broken = false;
      fireEvent.press(screen.getByText('Try again'));
      expect(screen.getByText('Home')).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('§5.11: an error nothing caught is reported, then handed to the previous handler; removal restores it', () => {
    const reporter = new MemoryCrashReporter();
    const seen: unknown[] = [];
    let handler: (error: unknown, isFatal?: boolean) => void = (error) => seen.push(error);
    const errorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next: typeof handler) => {
        handler = next;
      },
    };
    const original = handler;
    const remove = installGlobalCrashHandler(reporter, () => NOW, errorUtils);
    const boom = new Error('boom');
    handler(boom, true);
    expect(reporter.reports).toEqual([
      { source: 'global', message: 'boom', correlationId: null, fatal: true, at: NOW },
    ]);
    expect(seen).toEqual([boom]);
    remove();
    expect(handler).toBe(original);
  });
});
