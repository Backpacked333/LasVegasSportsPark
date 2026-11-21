/**
 * Staff S 4c household record (SPK-IAM-001, SPK-SUPPORT-001, §4.10, §4.14) and S 4a front desk
 * sale with the family chosen (SPK-PAY-009, SPK-PAY-012, money never optimistic).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACILITY_A, createTestApp, mePermissions, staffMe } from '../../../../testing/test-app';

const HOUSEHOLD = '0192f1a0-0000-7000-8000-0000000000f9';
const DANA = '0192f1a0-0000-7000-8000-00000000da11';
const MAYA = '0192f1a0-0000-7000-8000-00000000aa01';
const FEE_2 = '0192f1a0-0000-7000-8000-00000000f002';
const FEE_3 = '0192f1a0-0000-7000-8000-00000000f003';
const CREDIT = '0192f1a0-0000-7000-8000-00000000cc01';

function person(id: string, givenName: string, kind: 'adult' | 'child', dateOfBirth: string) {
  return {
    id,
    kind,
    givenName,
    familyName: 'Ortiz',
    dateOfBirth,
    status: 'active',
    mergedIntoPersonId: null,
    revision: 1,
    createdAt: '2023-01-01T00:00:00.000Z',
    updatedAt: '2023-01-01T00:00:00.000Z',
    contactPoints:
      kind === 'adult'
        ? [
            {
              id: '0192f1a0-0000-7000-8000-0000000c0001',
              personId: id,
              kind: 'phone',
              value: '+17025550148',
              isPrimary: true,
              verifiedAt: null,
              createdAt: '2023-01-01T00:00:00.000Z',
            },
          ]
        : [],
  };
}

function obligation(id: string, description: string, dueAt: string) {
  return {
    id,
    debtor: { kind: 'person', personId: DANA },
    mode: 'individual',
    responsiblePayerPersonId: null,
    source: { kind: 'manual' },
    orderId: null,
    description,
    dueAt,
    status: 'open',
    totals: {
      amountMinor: 4_000,
      receivedMinor: 0,
      allocatedMinor: 0,
      remainingMinor: 4_000,
      excessMinor: 0,
      currency: 'USD',
    },
    contributions: [],
    liveAttempt: null,
    lastReminderAt: null,
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function routes() {
  const me = staffMe([FACILITY_A]);
  return {
    'GET /me': me,
    'GET /me/permissions': mePermissions({ actions: ['identity.read_care_notes'] }),
    'GET /households/{id}': {
      status: 200,
      body: {
        id: HOUSEHOLD,
        name: 'Ortiz household',
        members: [
          { personId: DANA, label: null },
          { personId: MAYA, label: null },
        ],
        revision: 1,
        createdAt: '2023-05-01T00:00:00.000Z',
      },
    },
    'GET /people/{id}': (request: { params: Record<string, string> }) =>
      new Response(
        JSON.stringify(
          request.params['id'] === DANA
            ? person(DANA, 'Dana', 'adult', '1990-04-11')
            : person(MAYA, 'Maya', 'child', '2018-03-01'),
        ),
        { status: 200 },
      ),
    'GET /people/{id}/money-summary': {
      status: 200,
      body: {
        personId: DANA,
        accountBalance: [{ currency: 'USD', amountMinor: 8_000 }],
        openObligations: 2,
        pastDueObligations: 0,
        creditsAvailable: [{ currency: 'USD', amountMinor: 2_500 }],
        creditsPendingApproval: [],
        paidThisYear: [],
        refundedThisYear: [],
        paidSince: '2026-01-01T00:00:00.000Z',
        yearTimeZone: 'America/Los_Angeles',
        asOf: '2026-10-24T12:00:00.000Z',
      },
    },
    'GET /credits': {
      status: 200,
      body: {
        items: [
          {
            id: CREDIT,
            ownerPersonId: DANA,
            currency: 'USD',
            originalMinor: 2_500,
            remainingMinor: 2_500,
            permittedUses: ['obligation', 'registration'],
            sourceKind: 'goodwill',
            sourceId: null,
            status: 'active',
            expiresAt: null,
            reason: 'Make-up class, Oct',
            approvedAt: null,
            redemptions: [],
            revision: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    },
    'GET /people/{id}/waivers': {
      status: 200,
      body: {
        personId: MAYA,
        evaluated: true,
        waivers: [
          {
            policyKey: 'liability',
            title: 'Liability waiver',
            status: 'current',
            reason: null,
            currentVersion: null,
            acceptance: null,
            validUntil: '2026-11-03T00:00:00.000Z',
            lapsedAt: null,
            rule: null,
            evaluatedAt: '2026-10-24T12:00:00.000Z',
            history: [],
            overrides: [],
          },
        ],
      },
    },
    'GET /visits': { status: 200, body: { items: [], nextCursor: null } },
    'GET /enrollments': {
      status: 200,
      body: {
        items: [
          {
            id: '0192f1a0-0000-7000-8000-00000000e001',
            status: 'confirmed',
            offering: { name: 'Desert Foxes U9 training' },
            price: { basePriceMinor: 12_000, currency: 'USD', chargeLines: [], priceRuleId: 'x' },
          },
        ],
        nextCursor: null,
      },
    },
    'GET /people/{id}/care-notes': {
      status: 200,
      body: {
        personId: MAYA,
        notes: [
          {
            id: '0192f1a0-0000-7000-8000-0000000000c9',
            personId: MAYA,
            kind: 'allergy',
            body: 'Peanuts. Carries an adrenaline pen.',
            status: 'active',
            recordedAt: '2026-01-01T00:00:00.000Z',
            retiredAt: null,
            revision: 1,
          },
        ],
      },
    },
    'GET /people/{id}/authority': {
      status: 200,
      body: {
        personId: MAYA,
        relationships: [],
        grants: [
          {
            grantId: '0192f1a0-0000-7000-8000-0000000a0001',
            relationshipId: '0192f1a0-0000-7000-8000-0000000000e9',
            relationshipKind: 'guardian',
            actorPersonId: DANA,
            actorDisplayName: 'Dana Ortiz',
            subjectPersonId: MAYA,
            subjectDisplayName: null,
            permission: 'collect',
            source: 'staff',
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveTo: null,
            revokedAt: null,
            status: 'effective',
            underReview: false,
            revision: 1,
          },
        ],
        households: [{ id: HOUSEHOLD, name: 'Ortiz household', memberCount: 2 }],
        pendingInvitations: [],
        accountLinked: false,
        claims: [],
      },
    },
    'GET /customers/{personId}/timeline': {
      status: 200,
      body: {
        person: null,
        scope: [],
        sources: [],
        generatedAt: '2026-10-24T12:00:00.000Z',
        nextCursor: null,
        entries: [
          {
            id: 'e1',
            occurredAt: '2026-10-24T15:31:00.000Z',
            category: 'payment',
            kind: 'payment',
            title: 'Paid instalment 1 of 3',
            personId: DANA,
            record: { type: 'payment', id: 'p' },
            status: null,
            amount: { amountMinor: 4_000, currency: 'USD' },
            facilityId: null,
            details: {},
          },
        ],
      },
    },
    'GET /obligations': {
      status: 200,
      body: {
        items: [
          obligation(
            FEE_2,
            'Spring Rec League · instalment 2 of 3 · Maya',
            '2026-10-27T01:00:00.000Z',
          ),
          obligation(
            FEE_3,
            'Spring Rec League · instalment 3 of 3 · Maya',
            '2026-11-27T01:00:00.000Z',
          ),
        ],
        nextCursor: null,
      },
    },
    'GET /pos-products': { status: 200, body: { items: [], nextCursor: null } },
    'GET /pos-registers': { status: 200, body: { items: [], nextCursor: null } },
    'POST /credits/{id}/redeem': { status: 201, body: { id: CREDIT } },
    'POST /cash-tenders': { status: 201, body: { id: 't' } },
  } as NonNullable<Parameters<typeof createTestApp>[0]>['routes'];
}

describe('S 4c household record', () => {
  it('S 4c: money, forms, each child with activities, flags and who may pick up, and the family timeline; Take payment opens the sale for this family', async () => {
    const app = createTestApp({ routes: routes() });
    render(app.at(`/people/households/${HOUSEHOLD}`));
    expect(await screen.findByRole('heading', { name: 'Ortiz household' })).toBeVisible();
    expect(await screen.findByText(/\(702\) 555-0148/)).toBeInTheDocument();
    expect(await screen.findByText('$80.00')).toBeInTheDocument();
    expect(screen.getByText('2 open fees')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(await screen.findByText('Make-up class, Oct')).toBeInTheDocument();
    expect(await screen.findByText("Maya's waiver ends Nov 3")).toBeInTheDocument();
    const maya = await screen.findByRole('region', { name: 'Maya Ortiz' });
    expect(await within(maya).findByText('Desert Foxes U9 training')).toBeInTheDocument();
    expect(await within(maya).findByText('✕ Peanuts allergy')).toBeInTheDocument();
    expect(await within(maya).findByText('Dana Ortiz')).toBeInTheDocument();
    expect(await screen.findByText(/Paid instalment 1 of 3/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Take payment' })).toHaveAttribute(
      'href',
      `/finance/point-of-sale/desk?household=${HOUSEHOLD}`,
    );
    // A staff note on a household has no API: proposed, not offered.
    expect(screen.getByRole('button', { name: /Add a staff note/ })).toBeDisabled();
  });
});

describe('S 4a front desk sale', () => {
  it('S 4a SPK-PAY-009: with the family chosen, owed fees come first; a tap adds and a second tap removes; credit applies by itself; cash settles through the API, never optimistically', async () => {
    const user = userEvent.setup();
    const app = createTestApp({ routes: routes() });
    render(app.at(`/finance/point-of-sale/desk?household=${HOUSEHOLD}`));
    const fee = await screen.findByRole('button', { name: /instalment 2 of 3/ });
    expect(screen.getByRole('tab', { name: 'Owed by this family' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(fee);
    expect(fee).toHaveAttribute('aria-pressed', 'true');
    await user.click(fee);
    expect(fee).toHaveAttribute('aria-pressed', 'false');
    await user.click(fee);
    const cart = screen.getByRole('list', { name: 'In the cart' });
    expect(within(cart).getByText('Family credit')).toBeInTheDocument();
    expect(within(cart).getByText('−$25.00')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    // A fee cannot go on a card from the desk.
    expect(screen.getByRole('button', { name: 'Charge card · $15.00' })).toBeDisabled();
    expect(
      screen.getByText('Fees are taken by cash or the card terminal at the desk.'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    expect(await screen.findByText('Paid $15.00 by cash')).toBeInTheDocument();
    const posts = app.fake.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.route)).toEqual(['/credits/{id}/redeem', '/cash-tenders']);
    expect(posts[0]?.body).toEqual({ obligationId: FEE_2, amountMinor: 2_500 });
    expect(posts[1]?.body).toEqual(
      expect.objectContaining({
        obligationId: FEE_2,
        tenderKind: 'cash',
        amountMinor: 1_500,
        payerPersonId: DANA,
      }),
    );
    await waitFor(() => expect(posts[1]?.headers['idempotency-key']).toBeTruthy());
  });
});
