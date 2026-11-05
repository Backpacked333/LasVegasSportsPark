/**
 * SCR-S-47 Integrations and configuration: the integration register (`GET /v1/admin/integrations`,
 * K-09) with each §5.2 provider-selection gate pending its decision and owner (no vendor named or
 * invented), its §5.1 fields "not recorded" and the adapters behind it; API connection test;
 * organization and facility settings (`GET /v1/admin/settings`) read-only with revisions and the
 * time zone checked as IANA (SPK-SCHED-008); policy versions with effective dates and approvals;
 * INTEGRATION_UNAVAILABLE with its owner (recovery required); ACCESS_DENIED not available.
 */
import { apiErrorBody, fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  adminSettings,
  integrations,
  ok,
  page,
  policyVersion,
} from '../../../features/insight-admin/__tests__/fixtures';
import { formatInstant } from '../../../features/insight-admin/format';
import { createTestApp } from '../../../testing/test-app';

function app(routes: Record<string, FakeHandler> = {}) {
  return createTestApp({
    routes: {
      'GET /admin/integrations': ok(integrations()),
      'GET /admin/settings': ok(adminSettings()),
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
  it('§5.2, K-09: shows every provider-selection gate from the register as waiting on its decision', async () => {
    render(app().at('/admin/integrations'));
    const gates = await screen.findByRole('list', { name: 'Provider-selection gates' });
    const items = within(gates).getAllByRole('listitem', { name: /./ });
    const decisions = ['DEC-018', 'DEC-019', 'DEC-020', 'DEC-021', 'DEC-022', 'DEC-023', 'DEC-013'];
    expect(items).toHaveLength(decisions.length);
    for (const [index, decision] of decisions.entries()) {
      const item = items[index] as HTMLElement;
      expect(within(item).getByText('Waiting on a decision')).toBeInTheDocument();
      expect(
        within(item).getByText(
          `Provider not selected: ${decision} (owner: Technical lead/account owners).`,
        ),
      ).toBeInTheDocument();
      expect(
        within(item).getByText(/Evidence \(documented → tested → accepted → live\): not recorded/),
      ).toBeInTheDocument();
    }
    expect(within(items[6] as HTMLElement).getByText('Operational assistant')).toBeInTheDocument();
    expect(
      screen.getByText(/No provider is selected: the API runs against its test adapters only/),
    ).toBeInTheDocument();
  });

  it('§5.1: shows each register field as not recorded and the adapters behind a gate', async () => {
    const user = userEvent.setup();
    render(app().at('/admin/integrations'));
    const payments = await screen.findByRole('listitem', {
      name: 'Payment processor and merchant arrangement',
    });
    await user.click(within(payments).getByText('Register fields (§5.1): 0 of 12 recorded'));
    expect(within(payments).getByText('Product and vendor')).toBeInTheDocument();
    expect(within(payments).getByText('Exit procedure')).toBeInTheDocument();
    expect(within(payments).getAllByText('Not recorded (pending DEC-019)')).toHaveLength(12);
    const adapters = within(payments).getByRole('list', {
      name: 'Adapters behind Payment processor and merchant arrangement',
    });
    expect(within(adapters).getByText(/FakePaymentProvider/)).toBeInTheDocument();
    expect(within(adapters).getByText('Test adapter (deterministic fake)')).toBeInTheDocument();
    expect(within(adapters).getByText('never serves production')).toBeInTheDocument();
    expect(
      within(adapters).getByText(
        /reproduces success, failure, timeout or unknown outcome, duplicate webhook · outcomes reconciled by Finance operator/,
      ),
    ).toBeInTheDocument();
    const identity = screen.getByRole('listitem', { name: 'Identity provider' });
    expect(
      within(identity).getByText('No adapter is registered behind this gate.'),
    ).toBeInTheDocument();
  });

  it('shows the integration register the API refuses as not available to the viewer', async () => {
    render(
      app({
        'GET /admin/integrations': () =>
          fakeResponse(
            403,
            apiErrorBody('ACCESS_DENIED', { message: 'You may not read the register.' }),
          ),
      }).at('/admin/integrations'),
    );
    const section = await screen.findByRole('region', { name: 'Provider connections' });
    expect(await within(section).findByText('Not available to you')).toBeInTheDocument();
    expect(within(section).getByText(/You may not read the register\./)).toBeInTheDocument();
  });

  it('links the capability switches and the provider events pages', async () => {
    render(app().at('/admin/integrations'));
    expect(
      await screen.findByRole('link', {
        name: 'Capability switches (conditional capabilities, DEC-016)',
      }),
    ).toHaveAttribute('href', '/admin/capabilities');
    expect(
      screen.getByRole('link', { name: 'Provider events received by the inbox' }),
    ).toHaveAttribute('href', '/admin/provider-events');
    const nav = screen.getByRole('navigation', { name: 'Administration pages' });
    expect(within(nav).getByRole('link', { name: 'Integrations and settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
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

  it('SPK-UX-008: settings that cannot be read are an error with its code, not an empty list', async () => {
    const test = app({
      'GET /admin/settings': () => fakeResponse(500, apiErrorBody('INTERNAL_ERROR')),
    });
    render(test.at('/admin/integrations'));
    const settings = await screen.findByRole('region', {
      name: 'Organization and facility settings',
    });
    expect((await within(settings).findAllByText(/INTERNAL_ERROR/)).length).toBeGreaterThan(0);
    expect(within(settings).queryByText(/No facility is configured/)).toBeNull();
    expect(within(settings).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('SPK-SCHED-008: reads the settings with revisions, checks each time zone, stays read-only', async () => {
    render(
      app({
        'GET /admin/settings': ok(
          adminSettings([
            { settings: { checkInOpensMinutesBefore: 30 } },
            { timezone: 'Pacific Standard', revision: 4 },
          ]),
        ),
      }).at('/admin/integrations'),
    );
    const settings = await screen.findByRole('region', {
      name: 'Organization and facility settings',
    });
    expect(
      await within(settings).findByText(/Sports Park Organization \(sports-park\)/),
    ).toBeInTheDocument();
    expect(within(settings).getByText(/· revision 3/)).toBeInTheDocument();
    const list = within(settings).getByRole('list', { name: 'Facility settings' });
    const [first, second] = within(list).getAllByRole('listitem') as HTMLElement[];
    expect(within(first!).getByText('valid IANA time zone')).toBeInTheDocument();
    expect(within(first!).getByText(/Local date 2026-10-24/)).toBeInTheDocument();
    expect(within(first!).getByText('checkInOpensMinutesBefore')).toBeInTheDocument();
    expect(within(first!).getByText(/address not set \(DEC-001\)/)).toBeInTheDocument();
    expect(within(second!).getByText('not a recognised IANA time zone')).toBeInTheDocument();
    expect(within(second!).getByText(/revision 4/)).toBeInTheDocument();
    expect(
      within(second!).getByText(/Facility-local times cannot be shown until the time zone/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', {
        name: 'Editing organization and facility settings: not available yet',
      }),
    ).toHaveTextContent('DEC-013');
  });

  it('shows settings the API refuses as not available to the viewer', async () => {
    render(
      app({
        'GET /admin/settings': () =>
          fakeResponse(403, apiErrorBody('ACCESS_DENIED', { message: 'Settings are restricted.' })),
      }).at('/admin/integrations'),
    );
    const settings = await screen.findByRole('region', {
      name: 'Organization and facility settings',
    });
    expect(await within(settings).findByText('Not available to you')).toBeInTheDocument();
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
