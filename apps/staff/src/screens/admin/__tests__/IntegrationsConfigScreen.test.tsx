/**
 * SCR-S-47 Integrations and configuration: §5.2 provider-selection gates shown as pending with
 * their decisions and owner (no vendor named or invented), §5.1 register and evidence as an API
 * gap, API connection test, facility time zone checked as IANA (SPK-SCHED-008), policy versions
 * with effective dates and approvals, INTEGRATION_UNAVAILABLE with its owner (recovery required).
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ok, page, policyVersion } from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { createTestApp, todayFeed } from '../../../testing/test-app';

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /health': ok({ status: 'ok', version: '1.4.0', database: 'ok' }),
      'GET /policy-versions': page([
        policyVersion(1),
        policyVersion(2, { approvalStatus: 'draft', approvedAt: null }),
      ]),
      ...routes,
    },
  });
}

describe('SCR-S-47 IntegrationsConfigScreen', () => {
  it('§5.2: shows the six provider-selection gates as waiting on their decisions', async () => {
    render(app().at('/admin/integrations'));
    const gates = await screen.findByRole('list', { name: 'Provider-selection gates' });
    const items = within(gates).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    for (const [index, decision] of [
      'DEC-018',
      'DEC-019',
      'DEC-020',
      'DEC-021',
      'DEC-022',
      'DEC-023',
    ].entries()) {
      const item = items[index] as HTMLElement;
      expect(within(item).getByText('Waiting on a decision')).toBeInTheDocument();
      expect(
        within(item).getByText(new RegExp(`Provider not selected: ${decision}`)),
      ).toBeInTheDocument();
    }
    expect(gates).toHaveTextContent('Technical lead/account owners');
    expect(
      screen.getByRole('region', { name: 'Integration register: not available yet' }),
    ).toHaveTextContent('product and vendor, account owner');
  });

  it('tests the API connection and shows versions and database status', async () => {
    const user = userEvent.setup();
    const test = app();
    render(test.at('/admin/integrations'));
    expect(await screen.findByText('API ok')).toBeInTheDocument();
    expect(screen.getByText('database ok')).toBeInTheDocument();
    expect(screen.getByText('version 0.1.0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(test.fake.requests.filter((r) => r.route === '/health').length).toBeGreaterThan(1),
    );
  });

  it('SCR-S-47: a failed connection re-check shows the failure, not the earlier result', async () => {
    const user = userEvent.setup();
    let checks = 0;
    const test = app({
      'GET /health': () => {
        checks += 1;
        return checks === 1
          ? fakeResponse(200, { status: 'ok', version: '1.2.3', database: 'ok' })
          : fakeResponse(502, apiErrorBody('INTERNAL_ERROR'));
      },
    });
    render(test.at('/admin/integrations'));
    expect(await screen.findByText('API ok')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Connection test failed')).toBeInTheDocument();
    expect(screen.queryByText('API ok')).toBeNull();
    expect(screen.getByText(/Last successful check/)).toBeInTheDocument();
  });

  it('SPK-UX-008: facilities that cannot be read are an error, not an empty list', async () => {
    const test = app({
      'GET /me': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
      'GET /today': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
    });
    render(test.at('/admin/integrations'));
    const settings = await screen.findByRole('region', {
      name: 'Organization and facility settings',
    });
    expect((await within(settings).findAllByText(/INTERNAL_ERROR/)).length).toBeGreaterThan(0);
    expect(within(settings).queryByText('No facility is listed for you.')).toBeNull();
  });

  it('SPK-SCHED-008: checks each facility time zone and keeps settings read-only', async () => {
    const feed = todayFeed();
    const facilities = (feed.body as { facilities: { timezone: string }[] }).facilities;
    (facilities[1] as { timezone: string }).timezone = 'Pacific Standard';
    render(
      createTestApp({
        routes: {
          'GET /today': feed,
          'GET /health': ok({ status: 'ok', version: '1', database: 'ok' }),
          'GET /policy-versions': page([]),
        },
      }).at('/admin/integrations'),
    );
    const list = await screen.findByRole('list', { name: 'Facility settings' });
    const [first, second] = within(list).getAllByRole('listitem') as HTMLElement[];
    expect(within(first!).getByText('valid IANA time zone')).toBeInTheDocument();
    expect(within(second!).getByText('not a recognised IANA time zone')).toBeInTheDocument();
    expect(
      screen.getByRole('region', {
        name: 'Editing organization and facility settings: not available yet',
      }),
    ).toBeInTheDocument();
  });

  it('lists policy versions with status and effective dates, and their approvals on request', async () => {
    const user = userEvent.setup();
    const test = app({
      'GET /policy-versions/{id}/approvals': ok([
        {
          id: 'a1',
          subjectType: 'policy_version',
          subjectId: policyVersion(1).id,
          decision: 'approved',
          actorPersonId: null,
          reason: 'Finance sign-off',
          occurredAt: '2026-08-30T07:00:00.000Z',
        },
      ]),
    });
    render(test.at('/admin/integrations'));
    const list = await screen.findByRole('list', { name: 'Policy versions' });
    expect(within(list).getByText('approved')).toBeInTheDocument();
    expect(within(list).getByText('draft')).toBeInTheDocument();
    expect(
      within(list).getAllByText((text) =>
        text.includes(`effective ${formatInstant('2026-09-01T07:00:00.000Z')}`),
      ).length,
    ).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Approvals of Refund terms 1 version 1' }));
    expect(await screen.findByText(/approved .*: Finance sign-off/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Approval status'), 'draft');
    await waitFor(() =>
      expect(
        test.fake.requests.some(
          (r) => r.route === '/policy-versions' && r.query.approvalStatus === 'draft',
        ),
      ).toBe(true),
    );
  });

  it('recovery required: INTEGRATION_UNAVAILABLE names the owner and offers a retry', async () => {
    render(
      app({
        'GET /policy-versions': () =>
          fakeResponse(
            503,
            apiErrorBody('INTEGRATION_UNAVAILABLE', {
              nextAction: 'retry_later',
              message: 'A dependency is unavailable.',
            }),
          ),
      }).at('/admin/integrations'),
    );
    expect(
      await screen.findByText(
        'Error code: INTEGRATION_UNAVAILABLE. Reference: test-correlation-id',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Owner: Technical lead\/account owners \(DEC-013\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows policy versions the viewer may not read as not available to them', async () => {
    render(
      app({
        'GET /policy-versions': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', {
              message: 'You are not permitted to perform this action.',
            }),
          ),
      }).at('/admin/integrations'),
    );
    expect(await screen.findByText('Not available to you')).toBeInTheDocument();
  });
});
