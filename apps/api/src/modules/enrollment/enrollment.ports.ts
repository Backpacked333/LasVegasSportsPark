import type {
  Basket,
  CapacityPool,
  Enrollment,
  FinancialConsequence,
  Hold,
  Principal,
  SessionBooking,
  WaitlistEntry,
  WaitlistOffer,
  z,
} from '@sportspark/contracts';
import type { Trx } from '../../kernel';
import type { BookingKindSchema, BookingStatusSchema } from './enrollment.events';

/**
 * Ports other modules consume (README "Ports"). Finance's checkout coordinator (§4.11) reads the
 * basket with its price snapshots and policies, commits the holds after authoritative payment
 * evidence, and confirms or fails each enrollment; entry reads enrollments and session bookings
 * for arrival. Reads take the organization explicitly and an optional transaction; writes run in
 * the caller's transaction so money facts and participation commit together.
 */
export const ENROLLMENT_PORT = Symbol('ENROLLMENT_PORT');
export const CAPACITY_PORT = Symbol('CAPACITY_PORT');
export const BASKET_PORT = Symbol('BASKET_PORT');
export const WAITLIST_PORT = Symbol('WAITLIST_PORT');
/** Interface token: finance registers FINANCE_POLICY_IMPL; until then no financial consequence applies. */
export const FINANCE_POLICY_PORT = Symbol('FINANCE_POLICY_PORT');
export const FINANCE_POLICY_IMPL = Symbol('FINANCE_POLICY_IMPL');

export interface ConfirmEnrollmentOptions {
  /** Finance order id recorded on the enrollment. */
  orderRef?: string | null;
  actor: Principal;
  correlationId?: string | null;
  operationId?: string | null;
}

/** One participant's current commitments (SPK-AT-015: entry records only the actual child and session). */
export interface ParticipationSummary {
  participantPersonId: string;
  enrollments: Enrollment[];
  sessionBookings: SessionBooking[];
}

export interface EnrollmentPort {
  /**
   * Active (pending or confirmed) enrollments and session bookings per participant, each person
   * separately so arrival for one child never implies another (entry, SPK-ENTRY, SPK-AT-015).
   * Bookings are limited to the window when one is given.
   */
  participationsOf(
    organizationId: string,
    participantPersonIds: readonly string[],
    window?: { from: Date; to: Date },
    trx?: Trx,
  ): Promise<ParticipationSummary[]>;
  getEnrollment(
    organizationId: string,
    enrollmentId: string,
    trx?: Trx,
  ): Promise<Enrollment | null>;
  /** Active and historical holds of a basket. */
  holdsForBasket(organizationId: string, basketId: string, trx?: Trx): Promise<Hold[]>;
  /**
   * Converts holds to allocations atomically; fails with CAPACITY_UNAVAILABLE when any hold is not
   * active (expired, released or already committed by someone else). Nothing is written then.
   */
  commitHolds(trx: Trx, organizationId: string, holdIds: readonly string[]): Promise<Hold[]>;
  /**
   * After payment facts (§4.11 step 8): commits the enrollment's active holds, or, when its hold
   * expired, re-acquires the place only if it is still free — a waitlist offer's hold is never
   * displaced (SPK-AT-006) — else CAPACITY_UNAVAILABLE. Replays return the confirmed enrollment.
   */
  confirmEnrollment(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    options: ConfirmEnrollmentOptions,
  ): Promise<Enrollment>;
  /** Cancels a pending enrollment and releases its capacity (payment failed or compensation). */
  failConfirmation(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    reason: string,
    actor: Principal,
    correlationId?: string | null,
  ): Promise<Enrollment>;
  confirmSessionBooking(
    trx: Trx,
    organizationId: string,
    bookingId: string,
    options: ConfirmEnrollmentOptions,
  ): Promise<SessionBooking>;
}

export interface AcquireHoldInput {
  pools: ReadonlyArray<{ poolId: string; quantity: number }>;
  ownerKind: 'basket' | 'waitlist_offer' | 'session_booking' | 'placement' | 'staff';
  ownerId: string | null;
  basketId?: string | null;
  actor: Principal;
  expiresAt: Date;
  correlationId?: string | null;
}

export interface CapacityPort {
  poolsForOffering(organizationId: string, offeringId: string, trx?: Trx): Promise<CapacityPool[]>;
  getPool(organizationId: string, poolId: string, trx?: Trx): Promise<CapacityPool | null>;
  /** Holds on every pool in id order inside the caller's transaction; CAPACITY_UNAVAILABLE releases nothing. */
  acquireHolds(trx: Trx, organizationId: string, input: AcquireHoldInput): Promise<Hold[]>;
  releaseHold(
    trx: Trx,
    organizationId: string,
    holdId: string,
    reason: string,
    actor: Principal,
  ): Promise<Hold>;
}

export interface BasketPort {
  getBasket(organizationId: string, basketId: string, trx?: Trx): Promise<Basket | null>;
  /** Finance started a checkout: the basket keeps its pending enrollments until finance resolves them. */
  startCheckout(
    trx: Trx,
    organizationId: string,
    basketId: string,
    orderRef: string,
    actor: Principal,
  ): Promise<Basket>;
  /** SPK-REG-007: throws RESOURCE_CONFLICT (details.code APPROVAL_PENDING) while a line awaits review. */
  assertPaymentPermitted(trx: Trx, organizationId: string, basketId: string): Promise<Basket>;
  finishCheckout(
    trx: Trx,
    organizationId: string,
    basketId: string,
    outcome: 'fulfilled' | 'partially_fulfilled' | 'abandoned',
    actor: Principal,
  ): Promise<Basket>;
}

export interface WaitlistPort {
  getOffer(organizationId: string, offerId: string, trx?: Trx): Promise<WaitlistOffer | null>;
  entriesForPool(organizationId: string, poolId: string, trx?: Trx): Promise<WaitlistEntry[]>;
  /** Generates offers for the pool's free places by priority (idempotent; safe under replay). */
  offerFromPool(
    trx: Trx,
    organizationId: string,
    poolId: string,
    correlationId: string | null,
  ): Promise<WaitlistOffer[]>;
}

export interface TransferConsequenceInput {
  enrollmentId: string;
  participantPersonId: string;
  fromOfferingId: string;
  toOfferingId: string;
  fromPrice: { amountMinor: number; currency: string } | null;
  toPrice: { amountMinor: number; currency: string } | null;
  at: Date;
}

export interface CancellationConsequenceInput {
  enrollmentId: string;
  participantPersonId: string;
  offeringId: string;
  cancellationPolicyVersionId: string | null;
  price: { amountMinor: number; currency: string } | null;
  at: Date;
}

/**
 * Finance decides what a transfer or cancellation means in money (refund, credit, charge) under
 * the approved policies (DEC-009). Enrollment records the answer as a fact on the record.
 */
export interface FinancePolicyPort {
  transferConsequence(
    organizationId: string,
    input: TransferConsequenceInput,
    trx?: Trx,
  ): Promise<FinancialConsequence>;
  cancellationConsequence(
    organizationId: string,
    input: CancellationConsequenceInput,
    trx?: Trx,
  ): Promise<FinancialConsequence>;
}

/** Default until finance registers FINANCE_POLICY_IMPL: no financial consequence is asserted. */
export const noFinancialConsequence: FinancePolicyPort = {
  transferConsequence: async (_organizationId, input) => ({
    kind: 'none',
    amountMinor: null,
    currency: null,
    explanation:
      input.fromPrice && input.toPrice && input.fromPrice.amountMinor !== input.toPrice.amountMinor
        ? 'No finance policy is registered: the price difference is recorded for finance review.'
        : 'No finance policy is registered: no refund, credit or charge applies.',
    policyVersionId: null,
  }),
  cancellationConsequence: async () => ({
    kind: 'none',
    amountMinor: null,
    currency: null,
    explanation: 'No finance policy is registered: no refund or credit applies.',
    policyVersionId: null,
  }),
};

/** One booking in a period (ENR-10, IF-36), for reporting. */
export interface BookingOfPeriod {
  bookingId: string;
  kind: z.infer<typeof BookingKindSchema>;
  bookerPersonId: string;
  status: z.infer<typeof BookingStatusSchema>;
  /** ISO instant of the first occurrence. */
  firstStart: string;
  offeringId: string;
}

/**
 * Bookings (rentals and parties) whose first occurrence lies in [from, to) (ENR-10, IF-36).
 * Enrollment registers BOOKING_QUERY_IMPL (ENR-13); until then there are no bookings ([]).
 */
export interface BookingQueryPort {
  bookingsOfPeriod(
    organizationId: string,
    query: {
      facilityId?: string;
      from: string;
      to: string;
      kinds?: ReadonlyArray<BookingOfPeriod['kind']>;
    },
    trx?: Trx,
  ): Promise<BookingOfPeriod[]>;
}
export const BOOKING_QUERY_PORT = Symbol('BOOKING_QUERY_PORT');
export const BOOKING_QUERY_IMPL = Symbol('BOOKING_QUERY_IMPL');

/** The declared default: no bookings. */
export const noBookings: BookingQueryPort = {
  bookingsOfPeriod: async () => [],
};
