/**
 * SCR-S-15 offering publication (SPK-CAT-004, SPK-PAY-002): publication and registration shown
 * as separate states, the server's publication report on VALIDATION_FAILED, pause preserving
 * participation, stale and permission answers, and the DEC-007 pending state.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  OFFERING_ID,
  apiError,
  offering,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/price-rules': ok([]),
    ...extra,
  };
}

const PATH = `/programs/offerings/${OFFERING_ID}/publication`;

describe('SCR-S-15 OfferingPublicationScreen', () => {
  it('shows publication, registration and schedule as separate states, and what is configured', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(PATH));
    const states = await screen.findByRole('list', { name: 'Publication and registration state' });
    expect(within(states).getByText('draft')).toBeInTheDocument();
    expect(within(states).getByText('Registration not open')).toBeInTheDocument();
    expect(within(states).getByRole('link', { name: 'Schedule' })).toBeInTheDocument();
    const checklist = screen.getByRole('list', { name: 'Configuration checklist' });
    const cancellation = within(checklist)
      .getByText('Cancellation policy')
      .closest('li') as HTMLElement;
    expect(within(cancellation).getByText('Not set')).toBeInTheDocument();
    const window = within(checklist).getByText('Registration window').closest('li') as HTMLElement;
    expect(within(window).getByText('Set')).toBeInTheDocument();
    expect(screen.getByText(/depends on DEC-007/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate and publish' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open registration' })).toBeNull();
  });

  it('SPK-CAT-004: publishing with missing configuration shows the server report and changes nothing', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /offerings/{id}/publish': apiError(400, 'VALIDATION_FAILED', {
          message: 'The offering is missing required configuration for publication.',
          nextAction: 'correct_input',
          details: {
            problems: [
              {
                code: 'cancellation_policy_missing',
                field: 'cancellationPolicyVersionId',
                message: 'An approved cancellation policy version is required.',
              },
              {
                code: 'price_rule_missing',
                field: 'priceRules',
                message: 'A current or future price rule is required (SPK-PAY-001).',
              },
            ],
          },
        }),
      }),
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Validate and publish' }));
    const problems = await screen.findByRole('list', { name: 'Publication problems' });
    expect(
      within(problems).getByText(/An approved cancellation policy version is required/),
    ).toBeInTheDocument();
    expect(
      within(problems).getByText(/A current or future price rule is required/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Error code: VALIDATION_FAILED/)).toBeInTheDocument();
    const publish = app.fake.requests.find((r) => r.route === '/offerings/{id}/publish');
    expect(publish?.body).toEqual({ expectedRevision: 4 });
    expect(publish?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('pauses registration, keeping existing participation, and reports the new state', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /offerings/{id}': ok(offering({ publicationState: 'registration_open' })),
        'POST /offerings/{id}/registration/pause': ok(
          offering({ publicationState: 'registration_paused' }),
        ),
      }),
    });
    render(app.at(PATH));
    expect(await screen.findByText(/existing participation is preserved/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Validate and publish' })).toBeNull();
    await user.type(screen.getByLabelText(/^Reason or note/), 'Coach unavailable');
    await user.click(screen.getByRole('button', { name: 'Pause registration' }));
    expect(
      await screen.findByText('Done: the offering is now registration_paused.'),
    ).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/offerings/{id}/registration/pause')?.body,
    ).toEqual({
      expectedRevision: 4,
      reason: 'Coach unavailable',
    });
  });

  it('offers Reload after INVALID_TRANSITION and refetches the offering', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /offerings/{id}': ok(offering({ publicationState: 'published' })),
        'POST /offerings/{id}/registration/open': apiError(409, 'INVALID_TRANSITION', {
          message: 'OfferingPublication cannot open_registration from closed.',
          nextAction: 'reload_current_state',
        }),
      }),
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Open registration' }));
    expect(await screen.findByText('This record changed since it was loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(app.fake.requests.filter((r) => r.route === '/offerings/{id}')).toHaveLength(2),
    );
  });

  it('shows a missing publish permission as not available to the viewer', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /offerings/{id}/publish': apiError(403, 'ACCESS_DENIED', {
          nextAction: 'contact_support_or_request_access',
          details: { action: 'catalog.publish_offering' },
        }),
      }),
    });
    render(app.at(PATH));
    await user.click(await screen.findByRole('button', { name: 'Validate and publish' }));
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
    expect(screen.getByText(/catalog\.publish_offering/)).toBeInTheDocument();
  });

  it('keeps the offering on screen offline with its age and disables the commands', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(PATH));
    const publish = await screen.findByRole('button', { name: 'Validate and publish' });
    act(() => app.connectivity.set(false));
    await waitFor(() => expect(publish).toBeDisabled());
    expect(screen.getAllByText('You are offline').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/changing publication or registration needs a connection/),
    ).toBeInTheDocument();
  });
});
