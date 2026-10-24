/**
 * SCR-S-26 waitlist management (SPK-REG-008, SPK-AT-006, DEC-006): entries with priority basis,
 * preferences, status and offer history beside capacity, removal with a reason, no hand-issued
 * offers, and the permission restriction.
 */
import type { FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ENTRY_ID,
  OFFERING_ID,
  PROGRAM_ID,
  PERSON_ID,
  ADULT_ID,
  apiError,
  capacityPool,
  nameRoutes,
  offering,
  ok,
  program,
  waitlistEntry,
} from '../../../features/registration-finance/__tests__/fixtures';

const OFFERED = waitlistEntry({
  id: `${ENTRY_ID.slice(0, -1)}3`,
  participantPersonId: ADULT_ID,
  status: 'offered',
  position: null,
  offerCount: 1,
  offers: [
    {
      id: '0192f1a0-0000-7000-8000-000000000804',
      waitlistEntryId: `${ENTRY_ID.slice(0, -1)}3`,
      poolId: '0192f1a0-0000-7000-8000-000000000801',
      holdId: '0192f1a0-0000-7000-8000-000000000805',
      quantity: 1,
      offeredAt: '2026-10-24T08:00:00.000Z',
      expiresAt: '2026-10-26T08:00:00.000Z',
      status: 'offered',
      acceptedAt: null,
      acceptedBasketId: null,
      acceptedEnrollmentId: null,
      acceptedSessionBookingId: null,
      declinedAt: null,
      expiredAt: null,
      revision: 1,
    },
  ],
});

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(),
    'GET /capacity-pools': ok([capacityPool()]),
    'GET /waitlist-entries': ok([waitlistEntry(), OFFERED]),
    'GET /programs': ok({ items: [program()], nextCursor: null }),
    'GET /programs/{id}/offerings': ok({ items: [offering()], nextCursor: null }),
    ...extra,
  };
}

describe('SCR-S-26 WaitlistScreen', () => {
  it('SPK-REG-008: shows entries with priority basis, preferences, status and offer history beside capacity', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/registrations/waitlists/${OFFERING_ID}`));
    expect(await screen.findByRole('heading', { name: 'Spring academy U10' })).toBeInTheDocument();
    const pools = await screen.findByRole('list', { name: 'Capacity pools' });
    expect(within(pools).getByText('Full')).toBeInTheDocument();
    expect(within(pools).getByText(/committed 19 · held 1 · available 0/)).toBeInTheDocument();
    const entries = await screen.findByRole('list', { name: 'Waitlist entries' });
    const [first, second] = within(entries)
      .getAllByRole('listitem')
      .filter((li) => li.parentElement === entries);
    // The open offer comes first; the waiting entry keeps its position.
    expect(within(first!).getByText('Offer open, reserved place')).toBeInTheDocument();
    expect(within(first!).getByText(/expires Mon, Oct 26, 2026/)).toBeInTheDocument();
    expect(await within(second!).findByText('Alex Rivera')).toBeInTheDocument();
    expect(within(second!).getByText(/^1\./)).toBeInTheDocument();
    expect(within(second!).getByText(/priority basis joined at \(rank 0\)/)).toBeInTheDocument();
    expect(within(second!).getByText('Preferences: group: morning')).toBeInTheDocument();
    expect(within(second!).getByText('waiting')).toBeInTheDocument();
    expect(screen.getByText('Issuing an offer by hand is not available')).toBeInTheDocument();
    expect(screen.getByText(/pending DEC-006/)).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/waitlist-entries')?.query).toEqual({
      offeringId: OFFERING_ID,
    });
  });

  it('removes an entry only with a reason', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /waitlist-entries': ok([waitlistEntry()]),
        'POST /waitlist-entries/{id}/remove': ok(
          waitlistEntry({ status: 'removed', position: null }),
        ),
      }),
    });
    render(app.at(`/registrations/waitlists/${OFFERING_ID}`));
    await user.click(await screen.findByRole('button', { name: 'Remove…' }));
    const form = screen.getByRole('form', { name: 'Remove from the waitlist' });
    await user.click(within(form).getByRole('button', { name: 'Remove from the waitlist' }));
    expect(within(form).getByText(/A reason is required/)).toBeInTheDocument();
    expect(app.fake.requests.some((r) => r.route === '/waitlist-entries/{id}/remove')).toBe(false);
    await user.type(within(form).getByLabelText(/^Reason for removing/), 'Family asked to leave');
    await user.click(within(form).getByRole('button', { name: 'Remove from the waitlist' }));
    await waitFor(() => {
      const remove = app.fake.requests.find((r) => r.route === '/waitlist-entries/{id}/remove');
      expect(remove?.params).toEqual({ id: ENTRY_ID });
      expect(remove?.body).toEqual({ reason: 'Family asked to leave', expectedRevision: 1 });
      expect(remove?.headers['idempotency-key']).toMatch(/^key-/);
    });
  });

  it('chooses the offering by program and opens its waitlist', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes({ 'GET /waitlist-entries': ok([]) }) });
    render(app.at('/registrations/waitlists'));
    expect(await screen.findByText(/Choose a program and an offering/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Spring academy' })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText('Waitlist of: program'), PROGRAM_ID);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Spring academy U10/ })).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText('Waitlist of: offering'), OFFERING_ID);
    expect(await screen.findByRole('heading', { name: 'No waitlist' })).toBeInTheDocument();
  });

  it('shows a waitlist the viewer may not read as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /waitlist-entries': apiError(403, 'ACCESS_DENIED', {
          details: { action: 'enrollment.list_waitlist' },
        }),
      }),
    });
    render(app.at(`/registrations/waitlists/${OFFERING_ID}`));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText(PERSON_ID)).toBeNull();
  });
});
