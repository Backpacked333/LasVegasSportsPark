/**
 * §4.9, SPK-PAY-007, SPK-UX-008: every staff command failure view shows an answer that may have
 * taken effect the same way (`mayHaveTakenEffect` from @sportspark/api-client): a connection lost
 * after sending, a timeout, the same key still running or a 5xx is "Outcome not known yet" with a
 * same-key "Try again", never "Something went wrong" or "Nothing changed"; a failed read is not.
 * IDEMPOTENCY_OUTCOME_UNAVAILABLE is "This may already have been done" with "Reload"; a
 * legacy-authority refusal (K-11, §5.6) says to make the change in the system of record, never
 * "not available to you".
 */
import { ApiError, networkError, timeoutError } from '@sportspark/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { CommandError as CompetitionCommandError } from '../../features/competition/CommandError';
import { CommandError as InsightCommandError } from '../../features/insight-admin/feedback';
import { CommandError as OperationsCommandError } from '../../features/operations/feedback';
import { CommandError as PosCommandError } from '../../features/pos-access-accounting/CommandError';
import { CommandError as FinanceCommandError } from '../../features/registration-finance/CommandError';
import { CommandError as ScheduleCommandError } from '../../features/schedule-facilities/CommandError';
import { CommandError as SharedCommandError } from '../CommandFeedback';

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

function api(code: string, status: number, nextAction: string, details?: unknown): ApiError {
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

  it('a failed read changed nothing: it is never shown as an unknown outcome', () => {
    show(SharedCommandError as View, sent(networkError(new TypeError('Failed to fetch')), 'get'), {
      onRetry: () => undefined,
    });
    expect(screen.queryByTestId('state-outcome-unknown')).toBeNull();
  });
});
