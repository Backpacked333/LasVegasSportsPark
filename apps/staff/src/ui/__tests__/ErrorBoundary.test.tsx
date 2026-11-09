/**
 * SPK-UX-006 understandable error states, §5.11: a screen that fails while rendering is contained
 * and reported; failures nothing caught are reported too.
 */
import { ApiError } from '@sportspark/api-client';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { installGlobalCrashHandlers, MemoryCrashReporter } from '../../providers/crash-report';
import { RouteErrorBoundary } from '../ErrorBoundary';

const NOW = new Date('2026-11-09T12:00:00Z');

function Exploding({ when }: { when: () => boolean }) {
  if (when()) {
    throw new ApiError({
      kind: 'api',
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      nextAction: 'retry_later',
      correlationId: 'corr-render-1234',
      details: null,
    });
  }
  return <p>Today board</p>;
}

describe('ErrorBoundary (SPK-UX-006)', () => {
  it('SPK-UX-006: a render failure shows what happened, the support reference and a retry; it is reported once', async () => {
    const reporter = new MemoryCrashReporter();
    let broken = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <MemoryRouter initialEntries={['/today?search=Jane']}>
          <RouteErrorBoundary reporter={reporter} now={() => NOW}>
            <Exploding when={() => broken} />
          </RouteErrorBoundary>
        </MemoryRouter>,
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong on this screen',
      );
      expect(screen.getByText('corr-render-1234')).toBeInTheDocument();
      expect(reporter.reports).toEqual([
        {
          source: 'render',
          message: 'INTERNAL_ERROR: An unexpected error occurred.',
          correlationId: 'corr-render-1234',
          path: '/today',
          at: NOW,
        },
      ]);
      broken = false;
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByText('Today board')).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('§5.11: script errors and unhandled rejections are reported with the path, then the handlers can be removed', () => {
    const reporter = new MemoryCrashReporter();
    // An isolated target with the window's location: events dispatched on the real window would
    // also reach the test runner's own uncaught-error listener and fail the run.
    const target = Object.assign(new EventTarget(), {
      location: window.location,
    }) as unknown as Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'> &
      EventTarget;
    const remove = installGlobalCrashHandlers(target, reporter, () => NOW);
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('lost promise') });
    target.dispatchEvent(rejection);
    remove();
    target.dispatchEvent(new ErrorEvent('error', { error: new Error('after removal') }));
    expect(reporter.reports.map((r) => [r.source, r.message])).toEqual([
      ['window_error', 'boom'],
      ['unhandled_rejection', 'lost promise'],
    ]);
  });
});
