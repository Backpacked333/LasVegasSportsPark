/**
 * SCR-S-27 cancellation and transfer (SPK-REG-010, SPK-PAY-008, SPK-PAY-009, §4.8 transfer,
 * DEC-009, ENR-03): preview before commitment with participation, dates, capacity, the financial
 * consequence and approval (the read-only transfer preview); commands with the expected revision
 * and the accepted consequence bound to the preview; CONSEQUENCE_CHANGED, capacity changed, refund
 * pending and not-found answers; keyset paging of the enrollment lookup.
 */
import {
  capabilityDisabledBody,
  fakeResponse,
  type FakeHandler,
} from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import {
  ENROLLMENT_ID,
  ENROLLMENT_NEW_ID,
  NOW,
  REDEMPTION_ID,
  SUSPENSION_ID,
  enrollmentOffering,
  membershipSuspension,
  packageEntitlement,
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

    // ENR-03: a credit needs the customer's acceptance before the command can be sent.
    const submit = c.getByRole('button', { name: 'Cancel the enrollment' });
    expect(submit).toBeDisabled();
    await user.click(c.getByLabelText('The customer accepted the financial consequence shown'));
    await user.click(submit);
    expect(c.getByText(/A reason is required/)).toBeInTheDocument();
    await user.type(c.getByLabelText(/^Reason for canceling/), 'Moving away');
    await user.click(c.getByRole('button', { name: 'Cancel the enrollment' }));
    expect(await c.findByText('Enrollment now canceled.')).toBeInTheDocument();
    const sent = app.fake.requests.find((r) => r.route === '/enrollments/{id}/cancel');
    expect(sent?.body).toEqual({
      reason: 'Moving away',
      expectedRevision: 5,
      acceptedConsequence: { kind: 'credit', amountMinor: 5000, currency: 'USD' },
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('ENR-03: CONSEQUENCE_CHANGED commits nothing, shows the current consequence and asks to accept again', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'POST /enrollments/{id}/cancel': apiError(409, 'RESOURCE_CONFLICT', {
          message:
            'The financial consequence changed since it was previewed; review and accept it again.',
          nextAction: 'reload_current_state',
          details: {
            code: 'CONSEQUENCE_CHANGED',
            consequence: {
              kind: 'credit',
              amountMinor: 2500,
              currency: 'USD',
              explanation: 'Half the sessions have run.',
              policyVersionId: null,
            },
          },
        }),
      }),
    });
    render(app.at(PATH));
    const cancel = (await screen.findByRole('heading', { name: 'Cancel' })).closest(
      'section',
    ) as HTMLElement;
    const c = within(cancel);
    await user.type(await c.findByLabelText(/^Reason for canceling/), 'Moving away');
    await user.click(c.getByLabelText('The customer accepted the financial consequence shown'));
    await user.click(c.getByRole('button', { name: 'Cancel the enrollment' }));
    expect(await c.findByText('The financial consequence changed')).toBeInTheDocument();
    expect(c.getByText('Half the sessions have run.')).toBeInTheDocument();
    expect(
      c.getByText(/Error code: RESOURCE_CONFLICT \(CONSEQUENCE_CHANGED\)/),
    ).toBeInTheDocument();
    const reads = app.fake.requests.filter(
      (r) => r.route === '/enrollments/{id}/cancellation-preview',
    ).length;
    await user.click(c.getByRole('button', { name: 'Preview again' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/enrollments/{id}/cancellation-preview'),
      ).toHaveLength(reads + 1),
    );
    // The acceptance is asked again for the consequence shown now.
    expect(
      c.getByLabelText('The customer accepted the financial consequence shown'),
    ).not.toBeChecked();
    expect(c.getByLabelText(/^Reason for canceling/)).toHaveValue('Moving away');
  });

  it('ENR-03: reads the transfer preview, requires acceptance of the charge, then commits it as previewed and links both enrollments', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/transfer-preview': ok(transferPreview(false)),
        'POST /enrollments/{id}/transfer': ok(transferPreview(true)),
      }),
    });
    render(app.at(PATH));
    await screen.findByRole('heading', { name: 'Transfer' });
    const t = await chooseTarget(user);
    const preview = await t.findByRole('group', { name: 'Transfer preview' });
    expect(within(preview).getByText('Spring academy U10 evenings')).toBeInTheDocument();
    expect(
      within(preview).getByText(/Offering seats \(commercial\): 3 available/),
    ).toBeInTheDocument();
    expect(within(preview).getByText('Additional charge')).toBeInTheDocument();
    expect(within(preview).getByText(/(overlapping)/)).toBeInTheDocument();
    expect(
      app.fake.requests.find((r) => r.route === '/enrollments/{id}/transfer-preview')?.query,
    ).toEqual({ targetOfferingId: OFFERING_B_ID });
    // The preview is a read: nothing was posted for it.
    expect(app.fake.requests.some((r) => r.route === '/enrollments/{id}/transfer')).toBe(false);
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
        commit: true,
        acceptedConsequence: { kind: 'charge', amountMinor: 1500, currency: 'USD' },
        expectedRevision: 5,
      },
    ]);
    expect(calls[0]?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('ENR-03: a transfer refused with CONSEQUENCE_ACCEPTANCE_REQUIRED re-reads the preview', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/transfer-preview': ok(transferPreview(false)),
        'POST /enrollments/{id}/transfer': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'Review and accept the financial consequence before committing.',
          nextAction: 'reload_current_state',
          details: { code: 'CONSEQUENCE_ACCEPTANCE_REQUIRED' },
        }),
      }),
    });
    render(app.at(PATH));
    await screen.findByRole('heading', { name: 'Transfer' });
    const t = await chooseTarget(user);
    await t.findByRole('group', { name: 'Transfer preview' });
    await user.click(t.getByLabelText('The customer accepted the financial consequence shown'));
    await user.click(t.getByRole('button', { name: 'Transfer the enrollment' }));
    expect(
      await t.findByText('The financial consequence needs the customer’s acceptance'),
    ).toBeInTheDocument();
    await user.click(t.getByRole('button', { name: 'Preview again' }));
    await waitFor(() =>
      expect(
        app.fake.requests.filter((r) => r.route === '/enrollments/{id}/transfer-preview'),
      ).toHaveLength(2),
    );
  });

  it('reports capacity that changed before the commit and offers Reload', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}/transfer-preview': ok(transferPreview(false)),
        'POST /enrollments/{id}/transfer': apiError(409, 'CAPACITY_UNAVAILABLE', {
          message: 'No capacity is available.',
          nextAction: 'join_waitlist_or_choose_alternative',
        }),
      }),
    });
    render(app.at(PATH));
    await screen.findByRole('heading', { name: 'Transfer' });
    const t = await chooseTarget(user);
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
    await user.click(
      within(cancel).getByLabelText('The customer accepted the financial consequence shown'),
    );
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

  it('lists enrollments of an offering by keyset pages and opens one', async () => {
    const user = userEvent.setup();
    const second = enrollment({
      id: ENROLLMENT_NEW_ID,
      participantPersonId: '0192f1a0-0000-7000-8000-000000000302',
    });
    const app = createTestApp({
      routes: routes({
        'GET /enrollments': (request) =>
          fakeResponse(
            200,
            request.query.cursor === 'next'
              ? { items: [second], nextCursor: null }
              : { items: [enrollment()], nextCursor: 'next' },
          ),
        'GET /package-entitlements': ok({ items: [], nextCursor: null }),
      }),
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
    await user.click(screen.getByRole('button', { name: 'Load more enrollments' }));
    expect(await within(list).findByRole('link', { name: 'Sam Rivera' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more enrollments' })).toBeNull();
  });

  it('ENR-12: suspends a membership in facility time and ends the suspension with its revision; the switch shows as a notice', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}': ok(
          enrollment({ intent: 'membership', offering: enrollmentOffering('membership') }),
        ),
        'POST /enrollments/{id}/membership-suspensions': ok(membershipSuspension(), 201),
        'POST /membership-suspensions/{id}/end': ok(
          membershipSuspension({
            status: 'ended',
            endedAt: NOW,
            endedReason: 'Recovered',
            revision: 2,
          }),
        ),
      }),
    });
    render(app.at(PATH));
    const panel = (await screen.findByRole('heading', { name: 'Membership suspensions' })).closest(
      'section',
    ) as HTMLElement;
    const p = within(panel);
    // DEC-016, DEC-072: the switch is off by default; suspensions stay available.
    expect(await p.findByText('Memberships turned off')).toBeInTheDocument();
    expect(p.getByText(/never turned off/)).toBeInTheDocument();
    expect(
      p.getByText(/no read of a\s+membership’s suspensions|no read of a membership's suspensions/),
    ).toBeInTheDocument();
    const from = p.getByLabelText(/^Suspended from \(facility time, America\/Los_Angeles\)/);
    await user.click(p.getByRole('button', { name: 'Suspend the membership' }));
    expect(p.getByText('Enter when the suspension starts.')).toBeInTheDocument();
    expect(p.getByText(/A reason is required/)).toBeInTheDocument();
    await user.type(from, '2026-11-02T00:00');
    await user.type(p.getByLabelText(/^Reason for the suspension/), 'Injury');
    await user.click(p.getByRole('button', { name: 'Suspend the membership' }));
    const made = await p.findByRole('list', { name: 'Suspensions recorded here' });
    expect(within(made).getByText('Suspension active')).toBeInTheDocument();
    // SPK-SCHED-008: midnight in Los Angeles on 2 November is 08:00 UTC (PST, UTC-8).
    expect(
      app.fake.requests.find((r) => r.route === '/enrollments/{id}/membership-suspensions')?.body,
    ).toEqual({ from: '2026-11-02T08:00:00.000Z', reason: 'Injury' });
    await user.click(within(made).getByRole('button', { name: /^End the suspension from/ }));
    await user.type(within(made).getByLabelText(/^Reason for ending/), 'Recovered');
    await user.click(within(made).getByRole('button', { name: 'End the suspension' }));
    expect(await within(made).findByText('Suspension ended')).toBeInTheDocument();
    const end = app.fake.requests.find((r) => r.route === '/membership-suspensions/{id}/end');
    expect(end?.params).toEqual({ id: SUSPENSION_ID });
    expect(end?.body).toEqual({ reason: 'Recovered', expectedRevision: 1 });
    expect(end?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('ENR-12: an overlapping suspension is refused with its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['memberships'] }),
        'GET /enrollments/{id}': ok(
          enrollment({ intent: 'membership', offering: enrollmentOffering('membership') }),
        ),
        'POST /enrollments/{id}/membership-suspensions': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'The membership is already suspended in that period.',
          details: { code: 'SUSPENSION_OVERLAP' },
        }),
      }),
    });
    render(app.at(PATH));
    const panel = (await screen.findByRole('heading', { name: 'Membership suspensions' })).closest(
      'section',
    ) as HTMLElement;
    const p = within(panel);
    await user.type(await p.findByLabelText(/^Suspended from/), '2026-11-02T00:00');
    expect(p.queryByText('Memberships turned off')).toBeNull();
    await user.type(p.getByLabelText(/^Reason for the suspension/), 'Injury');
    await user.click(p.getByRole('button', { name: 'Suspend the membership' }));
    expect(await p.findByText(/already suspended in that period/)).toBeInTheDocument();
    expect(p.getByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
  });

  it('ENR-11: a package purchase lists its session package and reverses a redemption with a reason', async () => {
    const user = userEvent.setup();
    const reversed = packageEntitlement({
      redeemedCount: 0,
      remainingCredits: 10,
      redemptions: [
        ...packageEntitlement().redemptions,
        {
          id: '0192f1a0-0000-7000-8000-000000001406',
          sessionBookingId: '0192f1a0-0000-7000-8000-000000001405',
          kind: 'reversal',
          reversesRedemptionId: REDEMPTION_ID,
          reason: 'Session canceled by the coach',
          redeemedAt: NOW,
        },
      ],
    });
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['session_packages'] }),
        'GET /enrollments/{id}': ok(
          enrollment({ intent: 'package_purchase', offering: enrollmentOffering('package') }),
        ),
        'GET /package-entitlements': ok({ items: [packageEntitlement()], nextCursor: null }),
        'POST /package-redemptions/{id}/reverse': ok(reversed),
      }),
    });
    render(app.at(PATH));
    const list = await screen.findByRole('list', { name: 'Session packages' });
    const card = within(list).getAllByRole('listitem')[0]!;
    expect(within(card).getByText('Package active')).toBeInTheDocument();
    expect(within(card).getByText(/bought with this enrollment/)).toBeInTheDocument();
    expect(within(card).getByText('9')).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/package-entitlements')?.query).toMatchObject(
      { participantPersonId: enrollment().participantPersonId, offeringId: OFFERING_ID },
    );
    await user.click(within(card).getByRole('button', { name: /^Reverse the redemption of/ }));
    const form = within(card).getByRole('form', { name: /^Reverse the redemption of/ });
    await user.click(within(form).getByRole('button', { name: 'Reverse the redemption' }));
    expect(within(form).getByText(/A reason is required/)).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText(/^Reason for reversing/),
      'Session canceled by the coach',
    );
    await user.click(within(form).getByRole('button', { name: 'Reverse the redemption' }));
    expect(await within(form).findByText('Reversed: 10 of 10 credits remain.')).toBeInTheDocument();
    const sent = app.fake.requests.find((r) => r.route === '/package-redemptions/{id}/reverse');
    expect(sent?.params).toEqual({ id: REDEMPTION_ID });
    expect(sent?.body).toEqual({ reason: 'Session canceled by the coach' });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('ENR-11: a redemption already reversed is shown without Reverse; a refused reversal shows its code', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}': ok(enrollment({ intent: 'package_purchase' })),
        'GET /package-entitlements': ok({ items: [packageEntitlement()], nextCursor: null }),
        'POST /package-redemptions/{id}/reverse': apiError(409, 'RESOURCE_CONFLICT', {
          message: 'This redemption was already reversed.',
          details: { code: 'REDEMPTION_ALREADY_REVERSED' },
        }),
      }),
    });
    render(app.at(PATH));
    // DEC-074: the switch is off, the existing package is still listed and correctable.
    expect(await screen.findByText('Session packages turned off')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Session packages' });
    await user.click(within(list).getByRole('button', { name: /^Reverse the redemption of/ }));
    await user.type(within(list).getByLabelText(/^Reason for reversing/), 'Duplicate');
    await user.click(within(list).getByRole('button', { name: 'Reverse the redemption' }));
    expect(await within(list).findByText(/already reversed/)).toBeInTheDocument();
    expect(within(list).getByText(/Error code: RESOURCE_CONFLICT/)).toBeInTheDocument();
  });

  it('a package list the viewer may not read is not available, and a turned-off command shows turned off', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /enrollments/{id}': ok(
          enrollment({ intent: 'membership', offering: enrollmentOffering('membership') }),
        ),
        'POST /enrollments/{id}/membership-suspensions': () =>
          fakeResponse(403, capabilityDisabledBody('memberships', ['DEC-016', 'DEC-072'])),
      }),
    });
    render(app.at(PATH));
    const panel = (await screen.findByRole('heading', { name: 'Membership suspensions' })).closest(
      'section',
    ) as HTMLElement;
    const p = within(panel);
    await user.type(await p.findByLabelText(/^Suspended from/), '2026-11-02T00:00');
    await user.type(p.getByLabelText(/^Reason for the suspension/), 'Injury');
    await user.click(p.getByRole('button', { name: 'Suspend the membership' }));
    expect(
      await p.findByText(/Error code: ACCESS_DENIED \(CAPABILITY_DISABLED\)/),
    ).toBeInTheDocument();
  });
});
