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
import { INTENT_HANDLING, intentsFor } from '../intents';
import {
  MAX_WAITLIST_ENTRIES,
  memoryProgressBackend,
  parseProgress,
  RegistrationProgressStore,
} from '../progress';
import {
  basketStatus,
  checkoutInFlight,
  checkoutStatus,
  enrollmentStatus,
  holdStatus,
  paymentStatus,
  quoteStatus,
  registrationWindowStatus,
  waitlistEntryStatus,
} from '../status';
import {
  IDS,
  basket,
  checkout,
  inMinutes,
  offer,
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

describe('registration intents (SPK-REG-001)', () => {
  it('offers the intents the API accepts for the offering kind and routes each to its command', () => {
    expect(intentsFor('season')).toEqual([
      'individual_league',
      'join_team',
      'create_team_entry',
      'youth',
    ]);
    expect(intentsFor('pickup')).toEqual(['pickup']);
    expect(INTENT_HANDLING.join_team).toBe('team_invitation');
    expect(INTENT_HANDLING.pickup).toBe('session_booking');
    expect(INTENT_HANDLING.youth).toBe('basket');
  });
});

describe('registration progress on the device (§4.13, SPK-UX-001)', () => {
  it('keeps opaque ids per account and ignores another account or a corrupt value', async () => {
    const backend = memoryProgressBackend();
    const store = new RegistrationProgressStore(backend);
    await store.ensureLoaded(TEST_SESSION.accountId);
    await store.update({ basketId: IDS.basket, checkoutId: IDS.checkout });
    await store.update({ addWaitlistEntryId: IDS.entry });
    await store.update({ addWaitlistEntryId: IDS.entry });
    expect(store.snapshot()).toEqual({
      basketId: IDS.basket,
      quoteId: null,
      checkoutId: IDS.checkout,
      pendingCheckoutQuoteId: null,
      waitlistEntryIds: [IDS.entry],
    });
    expect(JSON.parse(backend.value as string).accountId).toBe(TEST_SESSION.accountId);
    expect(parseProgress(backend.value, 'another-account').basketId).toBeNull();
    expect(parseProgress('{not json', TEST_SESSION.accountId).basketId).toBeNull();
    expect(
      parseProgress(JSON.stringify({ accountId: 'a', basketId: 'Ada Example' }), 'a').basketId,
    ).toBeNull();
  });

  it('bounds the remembered waitlist entries', async () => {
    const store = new RegistrationProgressStore(memoryProgressBackend());
    await store.ensureLoaded(TEST_SESSION.accountId);
    for (let i = 0; i < MAX_WAITLIST_ENTRIES + 5; i += 1) {
      await store.update({
        addWaitlistEntryId: `0192f1a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
      });
    }
    expect(store.snapshot().waitlistEntryIds).toHaveLength(MAX_WAITLIST_ENTRIES);
  });
});
