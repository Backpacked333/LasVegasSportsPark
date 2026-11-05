/**
 * Registration vocabulary and helpers: the docs/package-a/journeys.md section 3 phrases
 * (SPK-UX-004, SPK-UX-010), non-colour status (SPK-UX-009), payment uncertainty (SPK-PAY-007),
 * server-owned expiry (SPK-REG-006), intents (SPK-REG-001) and the device progress store (§4.13,
 * SPK-UX-001 resume after interruption).
 */
import { STATUS_GLYPHS } from '../../../ui/StatusBadge';
import { TEST_NOW, TEST_SESSION } from '../../../testing/test-app';
import {
  ageBandLabel,
  capacityLabel,
  fieldMessages,
  formatDateOnly,
  formatMoney,
  timeLeftPhrase,
} from '../format';
import { basketInProgress, checkoutNeedsAttention, checkoutOf, openBasketOf } from '../in-progress';
import { INTENT_CAPABILITY, INTENT_HANDLING } from '../intents';
import { owesNothing, sessionBookingStatus, usablePackage } from '../SessionBooking';
import {
  blockingEligibilityReasons,
  eligibilityMessages,
  eligibilityStatus,
  optionsChunks,
} from '../options';
import { memoryProgressBackend, parseProgress, RegistrationProgressStore } from '../progress';
import {
  basketStatus,
  checkoutInFlight,
  checkoutStatus,
  enrollmentStatus,
  holdStatus,
  paymentStatus,
  pendingLabel,
  quoteStatus,
  registrationWindowStatus,
  waitlistEntryStatus,
} from '../status';
import {
  IDS,
  basket,
  checkout,
  eligible,
  ineligible,
  inMinutes,
  offer,
  packageEntitlement,
  payment,
  quote,
  waitlistEntry,
} from '../testing/fixtures';

describe('status vocabulary (journeys.md section 3, SPK-UX-004)', () => {
  it('keeps "Payment processing", "Awaiting placement" and "Confirmed" distinct in tone, glyph and words', () => {
    const processing = paymentStatus(payment({ status: 'processing' }));
    const awaiting = enrollmentStatus({ status: 'confirmed' }, 'Autumn League', {
      status: 'unassigned',
    });
    const confirmed = enrollmentStatus({ status: 'confirmed' }, 'Autumn League', null);
    expect(processing.label).toBe('Payment processing');
    expect(awaiting.label).toBe('Confirmed in Autumn League. Awaiting placement.');
    expect(confirmed.label).toBe('Confirmed in Autumn League');
    const tones = new Set([processing.tone, awaiting.tone, confirmed.tone]);
    expect(tones.size).toBe(3);
    expect(new Set([...tones].map((t) => STATUS_GLYPHS[t])).size).toBe(3);
  });

  it('never reports an unknown payment outcome as failed (SPK-PAY-007)', () => {
    const unknown = paymentStatus(payment({ status: 'unknown' }));
    expect(unknown.label).toBe('Payment outcome being confirmed. Do not pay again.');
    expect(unknown.tone).not.toBe('danger');
    expect(paymentStatus(payment({ status: 'failed' })).label).toBe('Payment failed');
    expect(
      checkoutInFlight(
        checkout({ status: 'awaiting_payment', payment: payment({ status: 'unknown' }) }),
      ),
    ).toBe(true);
    expect(checkoutInFlight(checkout({ status: 'completed' }))).toBe(false);
  });

  it('names recovery and compensation in the customer vocabulary (§4.11)', () => {
    expect(checkoutStatus(checkout({ status: 'recovery_required' })).label).toBe(
      'Payment received. We are completing your registration.',
    );
    expect(checkoutStatus(checkout({ status: 'compensated' })).label).toBe(
      'Payment returned. Registration was not completed.',
    );
    expect(checkoutStatus(checkout({ status: 'finalizing' })).label).toBe('Payment processing');
    expect(
      checkoutStatus(
        checkout({ status: 'awaiting_payment', payment: payment({ status: 'action_required' }) }),
      ).label,
    ).toBe('Payment needs your action');
  });

  it('shows a paused registration as paused, never as closed (SPK-CAT-004)', () => {
    expect(
      registrationWindowStatus({
        publicationState: 'registration_paused',
        registrationOpensAt: null,
      }).label,
    ).toBe('Registration paused');
    expect(
      registrationWindowStatus({ publicationState: 'registration_open', registrationOpensAt: null })
        .label,
    ).toBe('Registration open');
    expect(
      registrationWindowStatus({
        publicationState: 'published',
        registrationOpensAt: '2026-11-01T15:00:00.000Z',
      }).label,
    ).toMatch(/^Registration opens /);
  });

  it('reads holds, quotes and offers from the server expiry (SPK-REG-006, POL-013, SPK-REG-008)', () => {
    expect(holdStatus(inMinutes(9), TEST_NOW).label).toMatch(/^Place held until /);
    expect(holdStatus(inMinutes(-1), TEST_NOW).label).toMatch(/Hold time is up/);
    expect(quoteStatus(quote(), TEST_NOW).label).toMatch(/^Price valid until /);
    expect(quoteStatus(quote({ expiresAt: inMinutes(-1) }), TEST_NOW).label).toBe(
      'Price expired. Get a new price.',
    );
    expect(
      waitlistEntryStatus(waitlistEntry({ status: 'offered', offers: [offer()] }), 'Camp', TEST_NOW)
        .label,
    ).toMatch(/^Place offered\. Accept by .+\.$/);
    expect(waitlistEntryStatus(waitlistEntry(), 'Camp', TEST_NOW).label).toBe(
      'Waitlisted for Camp. Position 3.',
    );
    expect(timeLeftPhrase(inMinutes(9), TEST_NOW)).toBe('about 9 minutes left');
    expect(basketStatus(basket({ status: 'expired' }), TEST_NOW).label).toBe(
      'Your held place was released',
    );
    expect(basketStatus(basket({ approvalPending: true }), TEST_NOW).label).toBe(
      'Awaiting approval',
    );
  });
});

describe('formatting (SPK-PAY-001)', () => {
  it('formats minor units, calendar dates, age bands and capacity without inventing values', () => {
    expect(formatMoney(12000, 'USD')).toBe('$120.00');
    expect(formatDateOnly('2026-11-02')).toBe('Nov 2, 2026');
    expect(ageBandLabel({ minAgeYears: 8, maxAgeYears: 10 })).toBe('Ages 8 to 10');
    expect(ageBandLabel({})).toBeNull();
    expect(capacityLabel({ unit: 'seats', limit: 1 })).toBe('1 place');
    expect(fieldMessages([{ path: 'notes', message: 'Too long', code: 'too_big' }])).toEqual({
      notes: 'Too long',
    });
    expect(fieldMessages({ path: 'signedByPersonId' })).toEqual({
      signedByPersonId: 'Check this entry.',
    });
  });
});

describe('registration intents (SPK-REG-001, ENR-05)', () => {
  it('carries each intent the API offers by its own command; Package G intents name their switch', () => {
    expect(INTENT_HANDLING.youth).toBe('basket');
    expect(INTENT_HANDLING.membership).toBe('basket');
    expect(INTENT_HANDLING.rental_request).toBe('booking');
    expect(INTENT_HANDLING.party_request).toBe('booking');
    expect(INTENT_HANDLING.makeup).toBe('makeup');
    expect(INTENT_HANDLING.join_team).toBe('team_invitation');
    expect(INTENT_HANDLING.pickup).toBe('session');
    expect(INTENT_HANDLING.trial).toBe('session');
    expect(INTENT_CAPABILITY.rental_request).toBe('rentals');
    expect(INTENT_CAPABILITY.pickup).toBe('pickup_sessions');
    expect(INTENT_CAPABILITY.youth).toBeUndefined();
  });
});

describe('session bookings (SPK-PLACE-004, SPK-YOUTH-003, ENR-11)', () => {
  it('offers a booking only when nothing is owed, reads "booked" only when the API confirmed it', () => {
    expect(owesNothing(null)).toBe(true);
    const base = {
      priceRuleId: IDS.priceRule,
      basePriceMinor: 0,
      currency: 'USD',
      chargeLines: [],
    };
    expect(owesNothing(base)).toBe(true);
    expect(owesNothing({ ...base, basePriceMinor: 1 })).toBe(false);
    const fee = {
      code: 'f',
      label: 'Fee',
      kind: 'fee' as const,
      amountMinor: 200,
      inclusive: false,
    };
    expect(owesNothing({ ...base, chargeLines: [fee] })).toBe(false);
    expect(owesNothing({ ...base, chargeLines: [{ ...fee, inclusive: true }] })).toBe(true);

    expect(sessionBookingStatus({ status: 'confirmed', expiresAt: null }, 'session')).toEqual({
      tone: 'success',
      label: 'Session booked',
    });
    const pending = sessionBookingStatus({ status: 'pending', expiresAt: null }, 'trial');
    expect(pending.label).toBe('Booking pending: a payment is needed.');
    expect(pending.label).not.toMatch(/booked/);

    const entitlement = packageEntitlement({
      remainingCredits: 2,
      appliesTo: { offeringIds: [], programIds: [IDS.program] },
    });
    const target = { id: IDS.offering, programId: IDS.program };
    expect(usablePackage(entitlement, target, IDS.childA)).toBe(true);
    expect(usablePackage(entitlement, target, IDS.childB)).toBe(false);
    expect(usablePackage({ ...entitlement, remainingCredits: 0 }, target, IDS.childA)).toBe(false);
    expect(usablePackage({ ...entitlement, status: 'expired' }, target, IDS.childA)).toBe(false);
  });
});

describe('eligibility preview (SPK-REG-002)', () => {
  it('reads eligible, not eligible, forms outstanding and unknown evidence apart, never unknown as a pass', () => {
    expect(eligibilityStatus(eligible())).toEqual({ tone: 'success', label: 'Eligible' });
    const blocked = ineligible('Too old for this age band.');
    expect(eligibilityStatus(blocked).label).toBe('Not eligible');
    expect(blockingEligibilityReasons(blocked)).toEqual(['Too old for this age band.']);
    expect(eligibilityMessages(blocked).alternatives).toEqual(['Choose an activity for this age.']);
    const unknown = {
      ...blocked,
      reasons: [
        { ...blocked.reasons[0]!, severity: 'unknown' as const, message: 'No birth date.' },
      ],
    };
    expect(eligibilityStatus(unknown)).toEqual({
      tone: 'warning',
      label: 'Eligibility not known yet',
    });
    expect(blockingEligibilityReasons(unknown)).toEqual([]);
    // As the evaluator sends it: an outstanding form is a `warning` and the result passes
    // (registration-eligibility.ts), with the "complete the acknowledgments" alternative.
    const forms = {
      ...eligible(),
      eligible: true,
      reasons: [
        {
          code: 'acknowledgment_missing',
          severity: 'warning' as const,
          message: '"Medical form" must be acknowledged by the participant or a guardian.',
          source: { type: 'policy_version', id: IDS.formPolicy },
          requiredAction: 'complete_acknowledgment',
        },
      ],
      alternatives: [
        {
          kind: 'complete_acknowledgment' as const,
          message: 'Complete the required acknowledgments.',
          offeringId: null,
        },
      ],
    };
    expect(eligibilityStatus(forms)).toEqual({
      tone: 'pending',
      label: 'Eligible once the required forms are signed',
    });
    expect(blockingEligibilityReasons(forms)).toEqual([]);
    expect(eligibilityMessages(forms).alternatives).toEqual([
      'Complete the required acknowledgments.',
    ]);
    // A passing result never lists the alternatives to a refusal.
    expect(
      eligibilityMessages({
        ...eligible(),
        alternatives: [{ kind: 'other_offering', message: 'Another activity.', offeringId: null }],
      }).alternatives,
    ).toEqual([]);
  });

  it('reads more than 20 people in groups of 20 (RegistrationOptionsQuery), nobody left unasked', () => {
    const ids = Array.from(
      { length: 45 },
      (_, i) => `0192f1a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const groups = optionsChunks([...ids].reverse());
    expect(groups.map((g) => g.length)).toEqual([20, 20, 5]);
    expect(groups.flat()).toEqual(ids);
    expect(optionsChunks([])).toEqual([[]]);
  });

  it('names a pending enrollment by what it waits for (journeys.md "Registration pending: <reason>")', () => {
    expect(pendingLabel('approval')).toBe('Registration pending: awaiting approval');
    expect(pendingLabel('forms')).toBe('Registration pending: a required form is not signed');
    expect(pendingLabel(null)).toBe('Registration pending');
    expect(
      enrollmentStatus({ status: 'confirmed' }, 'League', {
        status: 'assigned',
        assignedTeamName: 'Blue Comets',
      }).label,
    ).toBe('Confirmed: Blue Comets');
  });
});

describe('registrations in progress from the API (SPK-UX-001, SPK-AT-023)', () => {
  it('keeps open, held and paying baskets and checkouts that need attention', () => {
    expect(basketInProgress(basket())).toBe(true);
    expect(basketInProgress(basket({ lines: [] }))).toBe(false);
    expect(basketInProgress(basket({ status: 'fulfilled' }))).toBe(false);
    expect(checkoutNeedsAttention(checkout({ status: 'recovery_required' }))).toBe(true);
    expect(checkoutNeedsAttention(checkout({ status: 'completed' }))).toBe(false);
    expect(
      openBasketOf({ items: [basket({ status: 'held' }), basket({ id: IDS.offer })] })?.id,
    ).toBe(IDS.offer);
    expect(openBasketOf(undefined)).toBeUndefined();
    expect(checkoutOf({ items: [checkout()] }, { quoteId: IDS.quote2 })).toBeNull();
    expect(checkoutOf({ items: [checkout()] }, { basketId: IDS.basket })?.id).toBe(IDS.checkout);
  });
});

describe('registration progress on the device (§4.13, SPK-UX-001)', () => {
  it('keeps only the quote of an unanswered checkout, per account, and ignores older or corrupt values', async () => {
    const backend = memoryProgressBackend();
    const store = new RegistrationProgressStore(backend);
    await store.ensureLoaded(TEST_SESSION.accountId);
    await store.update({ pendingCheckoutQuoteId: IDS.quote });
    expect(store.snapshot()).toEqual({ pendingCheckoutQuoteId: IDS.quote });
    expect(JSON.parse(backend.value as string)).toEqual({
      accountId: TEST_SESSION.accountId,
      pendingCheckoutQuoteId: IDS.quote,
    });
    expect(parseProgress(backend.value, 'another-account').pendingCheckoutQuoteId).toBeNull();
    expect(parseProgress('{not json', TEST_SESSION.accountId).pendingCheckoutQuoteId).toBeNull();
    // An earlier build's value (basket, checkout and waitlist ids) brings nothing back.
    expect(
      parseProgress(
        JSON.stringify({ accountId: 'a', basketId: IDS.basket, pendingCheckoutQuoteId: 'Ada' }),
        'a',
      ),
    ).toEqual({ pendingCheckoutQuoteId: null });
  });
});
