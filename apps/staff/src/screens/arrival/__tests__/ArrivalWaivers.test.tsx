/**
 * SCR-S-28 liability waiver at the desk (SPK-REG-011, proposed amendment PA-01; SPK-REG-009;
 * capability `liability_waivers`, DEC-095 pending). A check-in that reports `waiver_missing` or
 * `waiver_lapsed` offers signing on the tablet (digital, the named signer), recording a signed
 * paper (a staff entry with the date on the paper) and, for a block, an override with a reason.
 */
import { apiErrorBody } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CHECKIN_1, CHILD_1, SESSION_1, checkin } from '../../../features/operations/testing';
import { createTestApp, mePermissions } from '../../../testing/test-app';
import { WaiverActions, waiverIssues } from '../WaiverActions';

const VERSION = '0192f1a0-0000-7000-8000-0000000004a1';
const GUARDIAN = '0192f1a0-0000-7000-8000-0000000004b1';

const waiverIssue = (
  code: 'waiver_missing' | 'waiver_lapsed',
  severity: 'warning' | 'blocking',
) => ({
  code,
  severity,
  message: '"Liability waiver" has not been accepted for this participant.',
  nextAction: 'accept_waiver',
  reference: { type: 'policy_version', id: VERSION },
});

const routes = {
  'GET /policy-versions/{id}': {
    status: 200,
    body: {
      id: VERSION,
      kind: 'waiver',
      key: 'liability',
      version: 4,
      title: 'Liability waiver',
      content: {
        text: 'I accept the risks of taking part.',
        renewal: { reacceptOnNewVersion: false, renewEveryMonths: null },
        enforcement: 'warn',
        overrideRoles: [],
      },
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      approvalStatus: 'approved',
      approvedAt: '2026-01-01T00:00:00.000Z',
      retiredAt: null,
      retiredReason: null,
      revision: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  'GET /people/{id}': {
    status: 200,
    body: { id: CHILD_1, kind: 'child', givenName: 'Alex', familyName: 'Rivera' },
  },
  'GET /people/{id}/authority': {
    status: 200,
    body: {
      personId: CHILD_1,
      relationships: [],
      grants: [
        {
          grantId: '0192f1a0-0000-7000-8000-0000000004c1',
          relationshipId: '0192f1a0-0000-7000-8000-0000000004d1',
          relationshipKind: 'guardian',
          actorPersonId: GUARDIAN,
          actorDisplayName: 'Sam Rivera',
          subjectPersonId: CHILD_1,
          subjectDisplayName: 'Alex',
          permission: 'complete_forms',
          source: 'staff',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          effectiveTo: null,
          revokedAt: null,
          status: 'effective',
          underReview: false,
          revision: 1,
        },
      ],
      households: [],
      pendingInvitations: [],
      accountLinked: false,
      claims: [],
    },
  },
};

function setup(
  issues: unknown[],
  status: 'held' | 'admitted',
  extra: Record<string, { status: number; body: unknown }> = {},
  actions = ['catalog.accept_waiver', 'catalog.override_waiver'],
) {
  const app = createTestApp({
    routes: {
      'GET /me/permissions': mePermissions({ actions, enabled: ['liability_waivers'] }),
      ...routes,
      ...extra,
    },
  });
  const onRecheck = vi.fn();
  const record = checkin(CHECKIN_1, CHILD_1, SESSION_1, status, issues);
  render(<WaiverActions checkin={record as never} onRecheck={onRecheck} />, {
    wrapper: app.wrapper,
  });
  return { app, onRecheck };
}

describe('SCR-S-28 liability waiver at the desk', () => {
  it('SPK-REG-009: a paper waiver is recorded as a staff entry with the date on the paper, never as a digital signature', async () => {
    const user = userEvent.setup();
    const { app, onRecheck } = setup([waiverIssue('waiver_missing', 'warning')], 'admitted', {
      'POST /waiver-acceptances': {
        status: 201,
        body: { id: '0192f1a0-0000-7000-8000-0000000004e1' },
      },
    });
    const group = await screen.findByRole('group', { name: 'Liability waiver' });
    // a waiver that only warns offers no override
    expect(within(group).queryByRole('button', { name: 'Override with reason' })).toBeNull();
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Record paper waiver' })).toBeEnabled(),
    );
    await user.click(within(group).getByRole('button', { name: 'Record paper waiver' }));
    const form = await screen.findByRole('group', { name: 'Record a paper Liability waiver' });
    expect(within(form).getByText(/never as the customer's digital signature/)).toBeInTheDocument();
    const submit = within(form).getByRole('button', { name: 'Record paper waiver' });
    expect(submit).toBeDisabled();
    await user.selectOptions(await within(form).findByLabelText(/Who signed the paper/), GUARDIAN);
    await user.type(within(form).getByLabelText(/Date on the paper/), '2026-10-20');
    await user.click(
      within(form).getByRole('checkbox', {
        name: 'I have the paper signed by Sam Rivera (guardian) in front of me',
      }),
    );
    await user.click(submit);
    await waitFor(() =>
      expect(app.fake.requests.some((r) => r.route === '/waiver-acceptances')).toBe(true),
    );
    const sent = app.fake.requests.find((r) => r.route === '/waiver-acceptances');
    expect(sent?.body).toEqual({
      subjectPersonId: CHILD_1,
      policyKey: 'liability',
      policyVersionId: VERSION,
      method: 'paper',
      paperDatedOn: '2026-10-20',
      signedByPersonId: GUARDIAN,
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
    expect(await screen.findByText('Paper waiver recorded')).toBeInTheDocument();
    // an admitted check-in is not evaluated again
    expect(onRecheck).not.toHaveBeenCalled();
  });

  it('SPK-REG-011: signing on the tablet stays a digital acceptance by the named signer, and a held check-in is checked again', async () => {
    const user = userEvent.setup();
    const { app, onRecheck } = setup([waiverIssue('waiver_lapsed', 'blocking')], 'held', {
      'POST /waiver-acceptances': {
        status: 201,
        body: { id: '0192f1a0-0000-7000-8000-0000000004e2' },
      },
    });
    const group = await screen.findByRole('group', { name: 'Liability waiver' });
    await waitFor(() =>
      expect(
        within(group).getByRole('button', { name: 'Sign waiver on this tablet' }),
      ).toBeEnabled(),
    );
    await user.click(within(group).getByRole('button', { name: 'Sign waiver on this tablet' }));
    const tablet = await screen.findByRole('group', {
      name: 'Sign Liability waiver on this tablet',
    });
    expect(
      await within(tablet).findByText('I accept the risks of taking part.'),
    ).toBeInTheDocument();
    expect(within(tablet).queryByLabelText(/Date on the paper/)).toBeNull();
    await user.selectOptions(await within(tablet).findByLabelText(/Who is signing/), GUARDIAN);
    await user.click(
      within(tablet).getByRole('checkbox', {
        name: 'Sam Rivera (guardian) read this waiver on this tablet and accepts it',
      }),
    );
    await user.click(within(tablet).getByRole('button', { name: 'Record acceptance' }));
    await waitFor(() => expect(onRecheck).toHaveBeenCalledTimes(1));
    expect(app.fake.requests.find((r) => r.route === '/waiver-acceptances')?.body).toEqual({
      subjectPersonId: CHILD_1,
      policyKey: 'liability',
      policyVersionId: VERSION,
      method: 'digital',
      signedByPersonId: GUARDIAN,
      evidence: { method: 'desk_tablet', signerPresent: true },
    });
  });

  it('SPK-REG-011: a blocking waiver can be overridden with a reason for this activity; a refusal by the approved rule is shown', async () => {
    const user = userEvent.setup();
    const { app, onRecheck } = setup([waiverIssue('waiver_missing', 'blocking')], 'held', {
      'POST /waiver-overrides': {
        status: 403,
        body: apiErrorBody('ACCESS_DENIED', {
          message: 'The approved waiver does not permit your role to override it.',
          details: { code: 'WAIVER_OVERRIDE_NOT_PERMITTED' },
        }),
      },
    });
    const group = await screen.findByRole('group', { name: 'Liability waiver' });
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Override with reason' })).toBeEnabled(),
    );
    await user.click(within(group).getByRole('button', { name: 'Override with reason' }));
    const form = await screen.findByRole('group', {
      name: 'Override the waiver for this activity',
    });
    const submit = within(form).getByRole('button', { name: 'Record override' });
    expect(submit).toBeDisabled();
    await user.type(
      within(form).getByLabelText(/Why is this participant let in/),
      'Guardian is bringing the form',
    );
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(
      await within(form).findByText(/does not permit your role to override it/),
    ).toBeInTheDocument();
    expect(app.fake.requests.find((r) => r.route === '/waiver-overrides')?.body).toEqual({
      personId: CHILD_1,
      policyKey: 'liability',
      activity: { type: 'offering_session', id: SESSION_1 },
      reason: 'Guardian is bringing the form',
    });
    expect(onRecheck).not.toHaveBeenCalled();
  });

  it('without the permission the actions are shown disabled with the reason', async () => {
    setup([waiverIssue('waiver_missing', 'blocking')], 'held', {}, []);
    const group = await screen.findByRole('group', { name: 'Liability waiver' });
    expect(within(group).getByRole('button', { name: 'Record paper waiver' })).toBeDisabled();
    expect(within(group).getByRole('button', { name: 'Override with reason' })).toBeDisabled();
    expect(
      within(group).getByText('Recording a waiver is not available to your role.'),
    ).toBeInTheDocument();
  });

  it('SPK-REG-011 with liability waivers turned off: a check-in carries no waiver issue, so nothing new is shown', () => {
    const missingForm = {
      code: 'missing_acknowledgment',
      severity: 'blocking',
      message: 'A required form has not been acknowledged for this participant.',
      nextAction: 'complete_acknowledgment',
      reference: { type: 'policy_version', id: VERSION },
    };
    const record = checkin(CHECKIN_1, CHILD_1, SESSION_1, 'held', [missingForm]);
    expect(waiverIssues(record as never)).toEqual([]);
    const app = createTestApp();
    render(<WaiverActions checkin={record as never} />, { wrapper: app.wrapper });
    expect(screen.queryByRole('group', { name: 'Liability waiver' })).toBeNull();
    // today's missing-form actions are unchanged
    expect(screen.getByRole('group', { name: 'Missing form' })).toBeInTheDocument();
    expect(app.fake.requests.some((r) => (r.route ?? '').includes('waiver'))).toBe(false);
  });
});
