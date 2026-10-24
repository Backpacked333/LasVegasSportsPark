/**
 * SCR-S-27 cancellation and transfer (SPK-REG-010, SPK-PAY-008, SPK-PAY-009, §4.8 transfer,
 * DEC-009): preview before commitment with participation, dates, capacity, the financial
 * consequence and approval; commands with the expected revision; acceptance of a consequence;
 * capacity changed, refund pending and not-found answers.
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing/test-app';
import {
  ENROLLMENT_ID,
  ENROLLMENT_NEW_ID,
  OFFERING_B_ID,
  OFFERING_ID,
  PROGRAM_ID,
  REFUND_ID,
  apiError,
  cancellationPreview,
  enrollment,
  nameRoutes,
  offering,
  ok,
  program,
  transferPreview,
} from '../../../features/registration-finance/__tests__/fixtures';

const OFFERINGS = [
  offering(),
  offering({ id: OFFERING_B_ID, name: 'Spring academy U10 evenings' }),
];

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    ...nameRoutes(OFFERINGS),
    'GET /enrollments/{id}': ok(enrollment()),
    'GET /enrollments/{id}/cancellation-preview': ok(cancellationPreview()),
    'GET /programs': ok({ items: [program()], nextCursor: null }),
    'GET /programs/{id}/offerings': ok({ items: OFFERINGS, nextCursor: null }),
    ...extra,
  };
}

const PATH = `/registrations/enrollments/${ENROLLMENT_ID}`;

async function chooseTarget(user: ReturnType<typeof userEvent.setup>) {
  const transfer = screen
    .getByRole('heading', { name: 'Transfer' })
    .closest('section') as HTMLElement;
  const t = within(transfer);
  await waitFor(() =>
    expect(t.getByRole('option', { name: 'Spring academy' })).toBeInTheDocument(),
  );
  await user.selectOptions(t.getByLabelText('Transfer to: program'), PROGRAM_ID);
  await waitFor(() => expect(t.getByRole('option', { name: /evenings/ })).toBeInTheDocument());
  // The current offering is not offered as a target.
  expect(t.queryByRole('option', { name: 'Spring academy U10 (draft)' })).toBeNull();
  await user.selectOptions(t.getByLabelText('Transfer to: offering'), OFFERING_B_ID);
  return t;
}

describe('SCR-S-27 EnrollmentChangeScreen', () => {
  it('SPK-REG-010: previews a cancellation and cancels only with a reason and the expected revision', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({ 'POST /enrollments/{id}/cancel': ok(enrollment({ status: 'canceled' })) }),
    });
    render(app.at(PATH));
    const cancel = (await screen.findByRole('heading', { name: 'Cancel' })).closest(
      'section',
    ) as HTMLElement;
    const c = within(cancel);
    expect(await c.findByText('Spring academy U10', { selector: 'dd' })).toBeInTheDocument();
    expect(c.getByText('1 Offering seats')).toBeInTheDocument();
    const consequence = c.getByRole('group', { name: 'Financial consequence' });
    expect(within(consequence).getByText('Credit')).toBeInTheDocument();
    expect(within(consequence).getByText(/\$50\.00/)).toBeInTheDocument();
    expect(within(consequence).getByText(/partial credit applies/)).toBeInTheDocument();
    expect(within(consequence).getByText(/pending DEC-009/)).toBeInTheDocument();

    await user.click(c.getByRole('button', { name: 'Cancel the enrollment' }));
    expect(c.getByText(/A reason is required/)).toBeInTheDocument();
    await user.type(c.getByLabelText(/^Reason for canceling/), 'Moving away');
    await user.click(c.getByRole('button', { name: 'Cancel the enrollment' }));
    expect(await c.findByText('Enrollment now canceled.')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/enrollments/{id}/cancel')?.body).toEqual({
      reason: 'Moving away',
      expectedRevision: 5,
    });
  });

  it('previews a transfer, requires the customer’s acceptance of the charge, then commits and links both enrollments', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/transfer': (request) =>
          fakeResponse(200, transferPreview((request.body as { commit: boolean }).commit)),
      }),
    });
    render(app.at(PATH));
    await screen.findByRole('heading', { name: 'Transfer' });
    const t = await chooseTarget(user);
    await user.click(t.getByRole('button', { name: 'Preview the transfer' }));
    const preview = await t.findByRole('group', { name: 'Transfer preview' });
    expect(within(preview).getByText('Spring academy U10 evenings')).toBeInTheDocument();
    expect(
      within(preview).getByText(/Offering seats \(commercial\): 3 available/),
    ).toBeInTheDocument();
    expect(within(preview).getByText('Additional charge')).toBeInTheDocument();
    expect(within(preview).getByText(/(overlapping)/)).toBeInTheDocument();
    const commit = t.getByRole('button', { name: 'Transfer the enrollment' });
    expect(commit).toBeDisabled();
    await user.click(t.getByLabelText('The customer accepted the financial consequence shown'));
    await user.click(commit);
    expect(await t.findByText(/attendance history stays on this one/)).toBeInTheDocument();
    expect(t.getByRole('link', { name: 'confirmed' })).toHaveAttribute(
      'href',
      `/registrations/enrollments/${ENROLLMENT_NEW_ID}`,
    );
    const calls = app.fake.requests.filter((r) => r.route === '/enrollments/{id}/transfer');
    expect(calls.map((r) => r.body)).toEqual([
      {
        targetOfferingId: OFFERING_B_ID,
        commit: false,
        acceptConsequence: false,
        expectedRevision: 5,
      },
      {
        targetOfferingId: OFFERING_B_ID,
        commit: true,
        acceptConsequence: true,
        expectedRevision: 5,
      },
    ]);
    expect(calls[0]?.headers['idempotency-key']).not.toEqual(calls[1]?.headers['idempotency-key']);
  });

  it('reports capacity that changed before the commit and offers Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/transfer': (request) =>
          (request.body as { commit: boolean }).commit
            ? apiError(409, 'CAPACITY_UNAVAILABLE', {
                message: 'No capacity is available.',
                nextAction: 'join_waitlist_or_choose_alternative',
              })()
            : fakeResponse(200, transferPreview(false)),
      }),
    });
    render(app.at(PATH));
    await screen.findByRole('heading', { name: 'Transfer' });
    const t = await chooseTarget(user);
    await user.click(t.getByRole('button', { name: 'Preview the transfer' }));
    await t.findByRole('group', { name: 'Transfer preview' });
    await user.click(t.getByLabelText('The customer accepted the financial consequence shown'));
    await user.click(t.getByRole('button', { name: 'Transfer the enrollment' }));
    expect(await t.findByText('Capacity changed or is not available')).toBeInTheDocument();
    await user.click(t.getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/enrollments/{id}' && r.method === 'GET'),
      ).toHaveLength(2),
    );
  });

  it('REFUND_PENDING on cancel is shown as recovery required with the pending refund', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/cancel': apiError(409, 'REFUND_PENDING', {
          message: 'A refund is pending on these funds.',
          nextAction: 'await_refund_resolution',
          details: { refundAttemptId: REFUND_ID, status: 'unknown' },
        }),
      }),
    });
    render(app.at(PATH));
    const cancel = (await screen.findByRole('heading', { name: 'Cancel' })).closest(
      'section',
    ) as HTMLElement;
    await user.type(await within(cancel).findByLabelText(/^Reason for canceling/), 'Moving away');
    await user.click(within(cancel).getByRole('button', { name: 'Cancel the enrollment' }));
    expect(
      await within(cancel).findByText('Recovery required: a refund is pending'),
    ).toBeInTheDocument();
    expect(within(cancel).getByRole('link', { name: 'Open the pending refund' })).toHaveAttribute(
      'href',
      `/finance/refunds/${REFUND_ID}`,
    );
  });

  it('does not offer a cancellation the policy does not permit', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/cancellation-preview': ok(cancellationPreview(false)),
      }),
    });
    render(app.at(PATH));
    expect(
      await screen.findByText(/does not permit canceling this enrollment now/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel the enrollment' })).toBeNull();
  });

  it('shows an enrollment the viewer may not see as not available', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}': apiError(404, 'NOT_FOUND', { nextAction: 'verify_reference' }),
      }),
    });
    render(app.at(PATH));
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Cancel' })).toBeNull();
  });

  it('lists enrollments of an offering and opens one', async () => {
    const app = createTestApp({
      routes: routes({ 'GET /enrollments': ok({ items: [enrollment()], nextCursor: null }) }),
    });
    render(app.at(`/registrations/enrollments?offering=${OFFERING_ID}`));
    const list = await screen.findByRole('list', { name: 'Enrollments' });
    const link = await within(list).findByRole('link', { name: 'Alex Rivera' });
    expect(link).toHaveAttribute('href', PATH);
    expect(within(list).getByText('confirmed')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/enrollments')?.query).toMatchObject({
      offeringId: OFFERING_ID,
      status: 'confirmed',
    });
  });
});
