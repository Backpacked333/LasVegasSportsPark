/**
 * §4.9, SPK-PAY-007, SPK-UX-008: every staff command failure view shows an answer that may have
 * taken effect the same way (`mayHaveTakenEffect` from @sportspark/api-client): a connection lost
 * after sending, a timeout, the same key still running or a 5xx is "Outcome not known yet" with a
 * same-key "Try again", never "Something went wrong" or "Nothing changed"; a failed read is not.
 * IDEMPOTENCY_OUTCOME_UNAVAILABLE is "This may already have been done" with "Reload"; a
 * legacy-authority refusal (K-11, §5.6) says to make the change in the system of record, never
 * "not available to you"; a guard's refusal before the key was claimed (restore recovery,
 * SPK-AT-028; assistant off, SPK-AUTO-005) shows the API's message and "Nothing was changed"; a
 * 2xx whose answer could not be read is an unknown outcome.
 */
import { ApiError, networkError, timeoutError } from '@sportspark/api-client';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { CommandError as CompetitionCommandError } from '../../features/competition/CommandError';
import { CommandError as InsightCommandError } from '../../features/insight-admin/feedback';
import { CommandError as OperationsCommandError } from '../../features/operations/feedback';
import { CommandError as PosCommandError } from '../../features/pos-access-accounting/CommandError';
import { CommandError as FinanceCommandError } from '../../features/registration-finance/CommandError';
import { CommandError as ScheduleCommandError } from '../../features/schedule-facilities/CommandError';
import { createTestApp } from '../../testing/test-app';
import { CommandError as SharedCommandError } from '../CommandFeedback';
import { StateView } from '../StateView';

type View = (props: {
  error: ApiError;
  onRetry?: () => void;
  onReload?: () => void;
}) => ReactElement | null;

const VIEWS: readonly [string, View][] = [
  ['ui/CommandFeedback', SharedCommandError as View],
  ['operations/feedback', OperationsCommandError as View],
  ['insight-admin/feedback', InsightCommandError as View],
  ['registration-finance/CommandError', FinanceCommandError as View],
  ['pos-access-accounting/CommandError', PosCommandError as View],
  ['competition/CommandError', CompetitionCommandError as View],
  ['schedule-facilities/CommandError', ScheduleCommandError as View],
];

function sent(error: ApiError, method = 'post'): ApiError {
  error.method = method;
  return error;
}

function api(
  code: string,
  status: number,
  nextAction: string,
  details?: unknown,
  method = 'post',
): ApiError {
  return sent(
    new ApiError({
      kind: 'api',
      status,
      code,
      message: `Safe message for ${code}.`,
      nextAction,
      correlationId: 'corr-9',
      details,
    }),
    method,
  );
}

function show(
  View: View,
  error: ApiError,
  actions: { onRetry?: () => void; onReload?: () => void },
) {
  return render(
    <MemoryRouter>
      <View error={error} {...actions} />
    </MemoryRouter>,
  );
}

describe('staff command failure views (§4.9, SPK-PAY-007, SPK-UX-008)', () => {
  it.each(VIEWS)(
    'SPK-PAY-007: %s shows a connection lost after sending as "Outcome not known yet" with a same-key Try again',
    async (_name, View) => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      show(View, sent(networkError(new TypeError('Failed to fetch'))), { onRetry });
      const unknown = screen.getByTestId('state-outcome-unknown');
      expect(within(unknown).getByText('Outcome not known yet')).toBeInTheDocument();
      expect(unknown).toHaveTextContent('may already have taken effect');
      expect(screen.queryByText('Something went wrong')).toBeNull();
      expect(screen.queryByText(/Nothing changed/)).toBeNull();
      await user.click(within(unknown).getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(VIEWS)(
    '§4.9: %s shows a timeout, IDEMPOTENCY_IN_PROGRESS and a 5xx as an unknown outcome too',
    (_name, View) => {
      for (const error of [
        sent(timeoutError(20_000)),
        api('IDEMPOTENCY_IN_PROGRESS', 409, 'retry_later_with_same_key'),
        api('INTERNAL_ERROR', 500, 'retry_or_contact_support'),
      ]) {
        const { unmount } = show(View, error, { onRetry: () => undefined });
        expect(screen.getByTestId('state-outcome-unknown'), error.code).toBeInTheDocument();
        unmount();
      }
    },
  );

  it.each(VIEWS)(
    '§4.9: %s shows IDEMPOTENCY_OUTCOME_UNAVAILABLE as "This may already have been done" with Reload',
    async (_name, View) => {
      const user = userEvent.setup();
      const onReload = vi.fn();
      show(View, api('IDEMPOTENCY_OUTCOME_UNAVAILABLE', 409, 'reload_current_state'), {
        onReload,
        onRetry: () => undefined,
      });
      const lost = screen.getByTestId('state-outcome-lost');
      expect(within(lost).getByText('This may already have been done')).toBeInTheDocument();
      expect(within(lost).queryByRole('button', { name: 'Try again' })).toBeNull();
      await user.click(within(lost).getByRole('button', { name: 'Reload' }));
      expect(onReload).toHaveBeenCalledTimes(1);
    },
  );

  it.each(VIEWS)(
    'K-11, §5.6: %s shows a legacy-authority refusal as "make this change in the system of record", not as a permission',
    (_name, View) => {
      show(
        View,
        api('ACCESS_DENIED', 403, 'write_in_authoritative_system', {
          code: 'LEGACY_AUTHORITY',
          recordCategory: 'enrollment',
          basis: 'assignment',
        }),
        {},
      );
      const legacy = screen.getByTestId('state-legacy-authority');
      expect(
        within(legacy).getByText('Make this change in the system of record'),
      ).toBeInTheDocument();
      expect(legacy).toHaveTextContent('enrollment records');
      expect(screen.queryByText('Not available to you')).toBeNull();
      expect(screen.queryByText(/not permitted/)).toBeNull();
    },
  );

  it.each(VIEWS)(
    'SPK-AT-028: %s shows a refusal during restore recovery (before the key was claimed) with the API message, never as an unknown outcome',
    async (_name, View) => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      const error = api('INTEGRATION_UNAVAILABLE', 503, 'retry_later', { reason: 'recovery_mode' });
      Object.assign(error, {
        message: 'Payments are paused while the service recovers from a restore. Try again later.',
      });
      show(View, error, { onRetry });
      const refused = screen.getByTestId('state-refused-before-running');
      expect(refused).toHaveTextContent(
        'Payments are paused while the service recovers from a restore. Try again later.',
      );
      expect(refused).toHaveTextContent('Nothing was changed');
      expect(screen.queryByTestId('state-outcome-unknown')).toBeNull();
      expect(screen.queryByText(/may already have taken effect/)).toBeNull();
      expect(screen.queryByText(/A provider this depends on/)).toBeNull();
      await user.click(within(refused).getByRole('button', { name: 'Try again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(VIEWS)(
    'SPK-AUTO-005: %s shows the assistant turned off (refused before running) with the API message',
    (_name, View) => {
      show(
        View,
        api('INTEGRATION_UNAVAILABLE', 503, 'retry_later', {
          capability: 'automation',
          reason: 'disabled',
        }),
        {},
      );
      expect(screen.getByTestId('state-refused-before-running')).toHaveTextContent(
        'Safe message for INTEGRATION_UNAVAILABLE.',
      );
      expect(screen.queryByTestId('state-outcome-unknown')).toBeNull();
    },
  );

  it.each(VIEWS)(
    'SPK-PAY-007: %s shows a 2xx whose answer could not be read as an unknown outcome with a same-key Try again',
    (_name, View) => {
      const unreadable = sent(
        new ApiError({
          kind: 'unexpected_response',
          status: 201,
          code: 'RESPONSE_UNREADABLE',
          message: 'The service answered, but its answer could not be read.',
          nextAction: 'retry_with_same_key',
          correlationId: 'corr-u',
        }),
      );
      show(View, unreadable, { onRetry: () => undefined });
      const unknown = screen.getByTestId('state-outcome-unknown');
      expect(unknown).toHaveTextContent('its answer could not be read');
      expect(unknown).toHaveTextContent('may already have taken effect');
      expect(within(unknown).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    },
  );

  it('§4.10: an unknown outcome the API answered shows the API’s own message', () => {
    show(
      SharedCommandError as View,
      api('INTEGRATION_UNAVAILABLE', 503, 'retry_later', { reason: 'provider_timeout' }),
      { onRetry: () => undefined },
    );
    expect(screen.getByTestId('state-outcome-unknown')).toHaveTextContent(
      'The service said: Safe message for INTEGRATION_UNAVAILABLE.',
    );
  });

  it('a failed read changed nothing: it is never shown as an unknown outcome', () => {
    show(SharedCommandError as View, sent(networkError(new TypeError('Failed to fetch')), 'get'), {
      onRetry: () => undefined,
    });
    expect(screen.queryByTestId('state-outcome-unknown')).toBeNull();
  });
});

describe('offline, "Try again" in the failure views needs a connection (§4.15, R3-SCREEN-STATES-01)', () => {
  function offline(element: ReactElement) {
    const app = createTestApp();
    act(() => app.connectivity.set(false));
    const Wrapper = app.wrapper;
    render(
      <Wrapper>
        <MemoryRouter>{element}</MemoryRouter>
      </Wrapper>,
    );
    return app;
  }

  it.each(VIEWS)(
    '%s: an unknown outcome and a refusal before running offer "Try again" disabled with "Needs a connection", never a control that does nothing',
    async (_name, View) => {
      const user = userEvent.setup();
      for (const [error, testId] of [
        [sent(networkError(new TypeError('Failed to fetch'))), 'state-outcome-unknown'],
        [
          api('INTEGRATION_UNAVAILABLE', 503, 'retry_later', { reason: 'recovery_mode' }),
          'state-refused-before-running',
        ],
      ] as const) {
        const onRetry = vi.fn();
        offline(<View error={error} onRetry={onRetry} />);
        const view = screen.getByTestId(testId);
        const retry = within(view).getByRole('button', { name: 'Try again' });
        expect(retry).toBeDisabled();
        expect(retry).toHaveAccessibleDescription('Needs a connection.');
        await user.click(retry);
        expect(onRetry).not.toHaveBeenCalled();
        cleanup();
      }
    },
  );

  it('StateView: a command’s retryable failure needs a connection; a read’s retry stays a plain button', () => {
    const onRetry = vi.fn();
    offline(
      <>
        <StateView
          variant="error"
          error={api('RATE_LIMITED', 429, 'retry_later')}
          onRetry={onRetry}
        />
        <StateView
          variant="error"
          error={api('RATE_LIMITED', 429, 'retry_later', undefined, 'get')}
          onRetry={onRetry}
        />
      </>,
    );
    const [command, read] = screen.getAllByRole('button', { name: 'Try again' });
    expect(command).toBeDisabled();
    expect(command).toHaveAccessibleDescription('Needs a connection.');
    expect(read).toBeEnabled();
  });
});
