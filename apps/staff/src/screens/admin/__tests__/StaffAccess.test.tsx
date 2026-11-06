/**
 * Staff access on SCR-S-46 and the administration overview (migration 0181; §2.1, §4.14,
 * SPK-IAM-004): last seen and the latest access review on each membership, recording a review with
 * the next date the reviewer chooses (never one's own), the organization summary line, inviting an
 * email address to take roles (the one-time code shown once; no channel approved, DEC-012/DEC-062)
 * and revoking a pending invitation with a reason.
 */
import { type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  PERSON_1,
  facilityList,
  ok,
  page,
  staffMembershipView,
  uuid,
} from '../../../features/insight-admin/__tests__/fixtures';
import { FACILITY_A, TEST_NOW, createTestApp, mePermissions } from '../../../testing/test-app';

const ADMIN = mePermissions({
  staffRoles: ['system_administrator'],
  actions: [
    'identity.manage_staff_membership',
    'identity.read_staff_membership',
    'identity.record_staff_access_review',
    'identity.read_staff_access_reviews',
    'identity.manage_staff_invitation',
    'identity.read_staff_invitations',
  ],
});
const INVITATION = uuid(701);
const hoursAgo = (h: number) => new Date(TEST_NOW.getTime() - h * 3_600_000).toISOString();

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITATION,
    recipientEmail: 'new.coach@example.test',
    roles: ['coach'],
    facilityIds: [FACILITY_A],
    status: 'pending',
    invitedByPersonId: uuid(902),
    invitedByDisplayName: 'Dana Reyes',
    expiresAt: '2026-10-27T12:00:00.000Z',
    acceptedAt: null,
    acceptedByPersonId: null,
    staffMembershipId: null,
    revokedAt: null,
    revision: 1,
    createdAt: hoursAgo(1),
    ...overrides,
  };
}

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /facilities': facilityList(),
      'GET /me/permissions': ADMIN,
      'GET /staff-memberships': page([
        staffMembershipView({
          lastSeenAt: hoursAgo(3),
          lastAccessReview: {
            reviewId: uuid(801),
            outcome: 'confirmed',
            reviewedAt: '2026-09-01T12:00:00.000Z',
            reviewedByPersonId: uuid(902),
            nextReviewDueAt: '2026-12-01T08:00:00.000Z',
          },
        }),
      ]),
      'GET /staff-access-summary': ok({
        asOf: TEST_NOW.toISOString(),
        staffInEffect: 41,
        neverReviewed: 2,
        overdue: 0,
        nextReviewDueAt: '2026-12-01T08:00:00.000Z',
      }),
      'GET /staff-invitations': page([invitation()]),
      ...routes,
    },
  });
}

describe('SCR-S-46 staff access', () => {
  it('§4.14: each membership shows last seen and its latest access review; the summary counts staff', async () => {
    render(app().at('/admin/accounts'));
    const list = await screen.findByRole('list', { name: 'Staff memberships' });
    const row = within(list).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('Seen 3 h ago')).toBeInTheDocument();
    expect(within(row).getByText(/Access confirmed .* next review/)).toBeInTheDocument();
    expect(await screen.findByTestId('access-summary')).toHaveTextContent(
      /41 staff · next access review .* · 2 never reviewed/,
    );
  });

  it('§4.14: records an access review with the outcome and the next date the reviewer chooses', async () => {
    const user = userEvent.setup();
    const a = app({
      'POST /staff-access-reviews': {
        status: 201,
        body: {
          id: uuid(802),
          personId: PERSON_1,
          outcome: 'changes_required',
          notes: null,
          rolesReviewed: ['scheduler'],
          reviewedByPersonId: uuid(902),
          reviewedAt: TEST_NOW.toISOString(),
          nextReviewDueAt: '2027-01-15T08:00:00.000Z',
        },
      },
    });
    render(a.at('/admin/accounts'));
    const list = await screen.findByRole('list', { name: 'Staff memberships' });
    await user.click(within(list).getByRole('button', { name: 'Record access review' }));
    const form = await screen.findByRole('form', { name: 'Access review for Alex Rivera' });
    await user.click(within(form).getByRole('button', { name: 'Save review' }));
    expect(within(form).getByText('Choose the outcome.')).toBeInTheDocument();
    expect(a.fake.requests.some((r) => r.route === '/staff-access-reviews')).toBe(false);
    await user.selectOptions(within(form).getByLabelText(/Outcome/), 'changes_required');
    await user.type(within(form).getByLabelText(/Next review due/), '2027-01-15');
    await user.click(within(form).getByRole('button', { name: 'Save review' }));
    expect(await screen.findByText(/Access review recorded for Alex Rivera/)).toBeInTheDocument();
    const posted = a.fake.requests.find((r) => r.route === '/staff-access-reviews');
    expect(posted?.body).toMatchObject({ personId: PERSON_1, outcome: 'changes_required' });
    expect(typeof (posted?.body as { nextReviewDueAt: string }).nextReviewDueAt).toBe('string');
    expect(posted?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('SPK-IAM-004: invites an email to take roles and shows the one-time code once, with the pending channel decision', async () => {
    const user = userEvent.setup();
    const a = app({
      'POST /staff-invitations': {
        status: 201,
        body: { ...invitation(), token: 'tok_0123456789abcdefghijklmnop' },
      },
    });
    render(a.at('/admin/accounts'));
    const form = await screen.findByRole('form', { name: 'Invite staff' });
    await user.click(within(form).getByRole('button', { name: 'Send invitation' }));
    expect(within(form).getByText('Enter an email address.')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/Email address/), 'new.coach@example.test');
    await user.click(within(form).getByRole('checkbox', { name: 'Coach or instructor' }));
    await user.click(await within(form).findByRole('checkbox', { name: 'North Park 1' }));
    await user.click(within(form).getByRole('button', { name: 'Send invitation' }));
    expect(await within(form).findByTestId('invitation-token')).toHaveTextContent(
      'tok_0123456789abcdefghijklmnop',
    );
    expect(within(form).getByText(/DEC-012, DEC-062/)).toBeInTheDocument();
    const posted = a.fake.requests.find(
      (r) => r.route === '/staff-invitations' && r.method === 'POST',
    );
    expect(posted?.body).toEqual({
      email: 'new.coach@example.test',
      roles: ['coach'],
      facilityIds: [FACILITY_A],
    });
  });

  it('SPK-IAM-004: lists invitations with their status and revokes a pending one with a reason', async () => {
    const user = userEvent.setup();
    const a = app({
      'POST /staff-invitations/{id}/revoke': ok(invitation({ status: 'revoked', revision: 2 })),
    });
    render(a.at('/admin/accounts'));
    const list = await screen.findByRole('list', { name: 'Staff invitations' });
    expect(within(list).getByText('new.coach@example.test')).toBeInTheDocument();
    expect(within(list).getByText('Invitation pending')).toBeInTheDocument();
    await user.click(
      within(list).getByRole('button', { name: 'Revoke invitation for new.coach@example.test' }),
    );
    await user.type(within(list).getByLabelText(/Reason/), 'wrong address');
    await user.click(within(list).getByRole('button', { name: 'Revoke invitation' }));
    expect(await within(list).findByText('Invitation revoked')).toBeInTheDocument();
    const revoked = a.fake.requests.find((r) => r.route === '/staff-invitations/{id}/revoke');
    expect(revoked?.params).toEqual({ id: INVITATION });
    expect(revoked?.body).toEqual({ reason: 'wrong address', expectedRevision: 1 });
  });

  it('administration overview: last seen on each account, the summary and the Invite staff action', async () => {
    render(app().at('/admin'));
    const accounts = await screen.findByRole('list', { name: 'Active staff roles' });
    expect(within(accounts).getByText('Seen 3 h ago')).toBeInTheDocument();
    expect(await screen.findByTestId('access-summary')).toHaveTextContent(/41 staff/);
    expect(screen.getByRole('link', { name: /Invite staff/ })).toHaveAttribute(
      'href',
      '/admin/accounts#invite-staff',
    );
  });
});
