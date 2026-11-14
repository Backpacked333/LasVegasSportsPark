/**
 * SCR-S-14 "Requires waiver" on the offering setup (SPK-REG-011, proposed amendment PA-01;
 * capability `liability_waivers`, DEC-095 pending).
 */
import { fakeResponse, type FakeHandler } from '@sportspark/api-client/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  NOW,
  OFFERING_ID,
  entitlement,
  offering,
  ok,
} from '../../../features/registration-finance/__tests__/fixtures';
import { createTestApp, mePermissions } from '../../../testing/test-app';

const VERSION = '0192f1a0-0000-7000-8000-0000000006a1';

const waiverVersion = (key: string, title: string, version: number) => ({
  id: `0192f1a0-0000-7000-8000-00000000${String(6000 + version).padStart(4, '0')}`,
  kind: 'waiver',
  key,
  version,
  title,
  content: {},
  effectiveFrom: NOW,
  effectiveTo: null,
  approvalStatus: 'approved',
  approvedAt: NOW,
  retiredAt: null,
  retiredReason: null,
  revision: 2,
  createdAt: NOW,
  updatedAt: NOW,
});

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET /offerings/{id}': ok(offering()),
    'GET /offerings/{id}/sessions': ok([]),
    'GET /offerings/{id}/price-rules': ok([]),
    'GET /policy-versions': (request) =>
      fakeResponse(200, {
        items:
          request.query['kind'] === 'waiver'
            ? [
                waiverVersion('liability', 'Liability waiver', 3),
                waiverVersion('liability', 'Liability waiver', 4),
                waiverVersion('camp-waiver', 'Camp waiver', 1),
              ]
            : [],
        nextCursor: null,
      }),
    'GET /entitlement-definitions': ok([entitlement()]),
    ...extra,
  };
}

describe('SCR-S-14 requires waiver', () => {
  it('SPK-REG-011: an offering names the waiver families it requires by key and saves them as one command', async () => {
    const user = userEvent.setup();
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({
          actions: ['catalog.manage_required_waivers'],
          enabled: ['liability_waivers'],
        }),
        'GET /offerings/{id}/required-waivers': ok({
          offeringId: OFFERING_ID,
          waivers: [
            {
              policyKey: 'liability',
              enforcement: 'warn',
              currentVersion: {
                policyVersionId: VERSION,
                version: 4,
                title: 'Liability waiver',
                effectiveFrom: NOW,
              },
            },
          ],
        }),
        'POST /offerings/{id}/required-waivers': ok({ offeringId: OFFERING_ID, waivers: [] }),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const panel = await screen.findByRole('region', { name: 'Requires waiver' });
    expect(within(panel).getByText(/Proposed \(DEC-095 pending\)/)).toBeInTheDocument();
    const liability = await within(panel).findByRole('checkbox', {
      name: 'Liability waiver (version 4): a missing waiver warns',
    });
    expect(liability).toBeChecked();
    const camp = within(panel).getByRole('checkbox', { name: 'Camp waiver (version 1)' });
    expect(camp).not.toBeChecked();
    const save = within(panel).getByRole('button', { name: 'Save required waivers' });
    expect(save).toBeDisabled();
    await user.click(camp);
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() =>
      expect(
        app.fake.requests.some(
          (r) => r.method === 'POST' && r.route === '/offerings/{id}/required-waivers',
        ),
      ).toBe(true),
    );
    const sent = app.fake.requests.find(
      (r) => r.method === 'POST' && r.route === '/offerings/{id}/required-waivers',
    );
    expect(sent?.body).toEqual({ policyKeys: ['liability', 'camp-waiver'] });
    expect(sent?.headers['idempotency-key']).toMatch(/^key-/);
  });

  it('a role that may not change the requirement sees it read-only with the reason', async () => {
    const app = createTestApp({
      routes: routes({
        'GET /me/permissions': mePermissions({ enabled: ['liability_waivers'] }),
        'GET /offerings/{id}/required-waivers': ok({ offeringId: OFFERING_ID, waivers: [] }),
      }),
    });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    const panel = await screen.findByRole('region', { name: 'Requires waiver' });
    expect(
      within(panel).getByText('Changing the required waivers is not available to your role.'),
    ).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Save required waivers' })).toBeDisabled();
  });

  it('SPK-REG-011 with liability waivers turned off: the section is absent and the API is not asked', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/programs/offerings/${OFFERING_ID}`));
    expect(await screen.findByRole('heading', { name: 'Spring academy U10' })).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Save offering' });
    expect(screen.queryByRole('region', { name: 'Requires waiver' })).toBeNull();
    expect(app.fake.requests.some((r) => r.route === '/offerings/{id}/required-waivers')).toBe(
      false,
    );
    expect(app.fake.requests.some((r) => r.query['kind'] === 'waiver')).toBe(false);
  });
});
