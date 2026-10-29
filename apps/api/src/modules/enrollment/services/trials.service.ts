import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ConvertTrialInput,
  type CreateTrialInput,
  type OfferingSession,
  type Principal,
  type RecordTrialOutcomeInput,
  type TrialConversion,
  type TrialParticipation,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type TrialParticipationsTable,
  type TrialParticipationStatus,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
} from '../../../kernel';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import { SESSION_INTENT_COMMANDS } from '../enrollment.policy';
import {
  actorSnapshot,
  isStaffLike,
  organizationOf,
  resolveCustomerPayer,
  toTrialParticipation,
  type Reader,
} from '../enrollment.shared';
import { ApplicationsService } from './applications.service';
import { BasketsService } from './baskets.service';
import { CatalogSessions } from './catalog-sessions';
import { EnrollmentsService } from './enrollments.service';
import { RegistrationEvaluator } from './registration-evaluator';
import { SessionBookingsService } from './session-bookings.service';

export type TrialRow = Selectable<TrialParticipationsTable>;

/** Trial outcomes and the states they may follow (trial participation lifecycle). */
const TRIAL_OUTCOMES: Record<
  RecordTrialOutcomeInput['outcome'],
  readonly TrialParticipationStatus[]
> = {
  attended: ['scheduled'],
  no_show: ['scheduled'],
  canceled: ['scheduled'],
};

/**
 * Trial participation (SPK-YOUTH-003, SPK-AT-019). A trial is its own record, never an
 * enrollment: it holds a seat in its session's pool through a trial booking, records attendance
 * as an outcome, and keeps that history after conversion. Conversion opens a follow-up basket that
 * reuses permitted information (participant, payer, the trial link) without charging or enrolling
 * anyone; the paid entitlement appears only when that basket is held and confirmed, and the
 * confirmation links it back to the trial (`converted`).
 */
@Injectable()
export class TrialsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly evaluator: RegistrationEvaluator,
    private readonly bookings: SessionBookingsService,
    private readonly baskets: BasketsService,
    private readonly applications: ApplicationsService,
    private readonly enrollments: EnrollmentsService,
    private readonly sessions: CatalogSessions,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<TrialRow | undefined> {
    let q = db
      .selectFrom('trial_participations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  // -------------------------------------------------------------------------------------------
  // POST /trial-participations
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    input: CreateTrialInput,
    correlationId: string | null,
  ): Promise<TrialParticipation> {
    const organizationId = organizationOf(principal);
    const session: OfferingSession | undefined = input.sessionId
      ? await this.sessions.get(organizationId, input.offeringId, input.sessionId)
      : undefined;
    return this.uow.run(async ({ trx }) => {
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        input.participantPersonId,
      );
      await this.authorization.require(principal, EnrollmentActions.recordTrial, {
        type: 'trial_participation',
        organizationId,
        subjectPersonIds: [person.id],
      });
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: 'trial',
        session: session ?? undefined,
      });
      this.bookings.assertBookable(evaluation.result, person.id);
      const id = newId();
      // §4.7 (1), SPK-REG-009: a customer books the trial as its own payer; staff may name one.
      const payerPersonId =
        resolveCustomerPayer(principal, input.payerPersonId, [principal.personId]) ??
        (isStaffLike(principal) ? null : principal.personId);
      try {
        await trx
          .insertInto('trial_participations')
          .values({
            id,
            organization_id: organizationId,
            offering_id: snapshot.offering.id,
            session_id: session?.id ?? null,
            session_booking_id: null,
            participant_person_id: person.id,
            application_id: null,
            status: 'scheduled',
            scheduled_for: session ? session.scheduledStart : null,
            attended_at: null,
            no_show_at: null,
            canceled_at: null,
            cancel_reason: null,
            follow_up_consent: input.followUpConsent,
            follow_up: json({}),
            converted_enrollment_id: null,
            converted_basket_id: null,
            converted_at: null,
            registered_by: json(actorSnapshot(principal)),
            registered_by_person_id: principal.personId,
            assisted_by_person_id: isStaffLike(principal) ? principal.personId : null,
          })
          .execute();
      } catch (error) {
        if (
          isUniqueViolation(error) &&
          pgConstraintName(error) === 'trial_participations_live_idx'
        ) {
          throw errors.duplicateEntitlement(
            'The participant already has a scheduled trial for this offering.',
            {
              participantPersonId: person.id,
              offeringId: snapshot.offering.id,
            },
          );
        }
        throw error;
      }
      if (session) {
        // The trial seat lives in the session's own pool; the booking record is kind `trial`.
        const booking = await this.bookings.createInTrx(trx, organizationId, {
          kind: 'trial',
          snapshot,
          session,
          person,
          evaluation,
          payerPersonId,
          actor: principal,
          correlationId,
        });
        await trx
          .updateTable('trial_participations')
          .set({ session_booking_id: booking.id })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .execute();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.recordTrial.id,
        targetType: 'trial_participation',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          offeringId: snapshot.offering.id,
          sessionId: session?.id ?? null,
          followUpConsent: input.followUpConsent,
          assistedByStaff: isStaffLike(principal),
        },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.trialRecorded, {
        organizationId,
        aggregateType: 'trial_participation',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          trialParticipationId: id,
          offeringId: snapshot.offering.id,
          participantPersonId: person.id,
        },
      });
      return toTrialParticipation((await this.load(trx, organizationId, id))!);
    });
  }

  async get(principal: Principal, id: string): Promise<TrialParticipation> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('trial_participation');
    await this.authorization.require(principal, EnrollmentActions.readTrial, {
      type: 'trial_participation',
      id,
      organizationId,
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return toTrialParticipation(row);
  }

  // -------------------------------------------------------------------------------------------
  // Outcome: attended / no_show (staff), canceled (participant authority or staff)
  // -------------------------------------------------------------------------------------------

  async recordOutcome(
    principal: Principal,
    id: string,
    input: RecordTrialOutcomeInput,
    correlationId: string | null,
  ): Promise<TrialParticipation> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('trial_participation');
      await this.authorization.require(principal, EnrollmentActions.recordTrial, {
        type: 'trial_participation',
        id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      if (input.outcome !== 'canceled' && !isStaffLike(principal)) {
        // Attendance is an operational observation, recorded by staff (entry owns arrival facts).
        throw errors.accessDenied('Only staff record trial attendance.');
      }
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (!TRIAL_OUTCOMES[input.outcome].includes(row.status)) {
        throw errors.invalidTransition('TrialParticipation', row.status, input.outcome);
      }
      if (
        input.outcome !== 'canceled' &&
        row.scheduled_for &&
        now.getTime() < new Date(row.scheduled_for).getTime()
      ) {
        // SPK-YOUTH-003, SPK-ENTRY-003, SPK-AT-019: attendance (or its absence) is observed, not
        // predicted; the trial history that conversion keeps must be a fact.
        throw errors.validation('A trial outcome cannot be recorded before its session starts.', {
          code: 'trial_not_started',
          scheduledFor: new Date(row.scheduled_for).toISOString(),
        });
      }
      if (input.outcome === 'canceled' && row.session_booking_id) {
        const booking = await this.bookings.load(trx, organizationId, row.session_booking_id, true);
        if (booking && (booking.status === 'pending' || booking.status === 'confirmed')) {
          await this.bookings.cancelInTrx(
            trx,
            organizationId,
            booking,
            input.reason ?? 'trial_canceled',
            principal,
            correlationId,
          );
        }
      }
      await trx
        .updateTable('trial_participations')
        .set({
          status: input.outcome,
          attended_at: input.outcome === 'attended' ? now : null,
          // SPK-AT-019: the no-show is its own fact, so conversion (status `converted`) keeps it.
          no_show_at: input.outcome === 'no_show' ? now : null,
          canceled_at: input.outcome === 'canceled' ? now : null,
          cancel_reason: input.outcome === 'canceled' ? (input.reason ?? 'canceled') : null,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.recordTrial.id,
        targetType: 'trial_participation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { outcome: input.outcome },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.trialChanged, {
        organizationId,
        aggregateType: 'trial_participation',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          trialParticipationId: id,
          status: input.outcome,
          convertedEnrollmentId: null,
          convertedBasketId: row.converted_basket_id,
        },
      });
      return toTrialParticipation((await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Conversion (SPK-AT-019): a follow-up basket, never a charge or an enrollment by itself
  // -------------------------------------------------------------------------------------------

  async convert(
    principal: Principal,
    id: string,
    input: ConvertTrialInput,
    correlationId: string | null,
  ): Promise<TrialConversion> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('trial_participation');
      await this.authorization.require(principal, EnrollmentActions.recordTrial, {
        type: 'trial_participation',
        id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (!['scheduled', 'attended', 'no_show'].includes(row.status) || row.converted_basket_id) {
        throw errors.invalidTransition('TrialParticipation', row.status, 'convert');
      }
      if (isStaffLike(principal) && !row.follow_up_consent) {
        // SPK-YOUTH-003: staff reuse trial information for a follow-up offer only when permitted.
        throw errors.resourceConflict(
          'The family has not permitted a follow-up offer from this trial.',
          {
            code: 'FOLLOW_UP_CONSENT_REQUIRED',
          },
        );
      }
      if (SESSION_INTENT_COMMANDS[input.intent]) {
        throw errors.validation('A trial converts into term, season or camp participation.', {
          path: 'intent',
        });
      }
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        row.participant_person_id,
      );
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.targetOfferingId);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: input.intent,
      });
      // The follow-up belongs to the family, never to the staff member who assists (SPK-REG-009):
      // staff name the payer, or reuse the trial's payer, or the adult who registered it themselves.
      const trialPayer = row.session_booking_id
        ? ((
            await trx
              .selectFrom('session_bookings')
              .select('payer_person_id')
              .where('organization_id', '=', organizationId)
              .where('id', '=', row.session_booking_id)
              .executeTakeFirst()
          )?.payer_person_id ?? null)
        : null;
      const familyRegistrant = row.assisted_by_person_id ? null : row.registered_by_person_id;
      // §4.7 (1), SPK-REG-009: a customer converts as their own payer; staff may name one.
      const payerPersonId = isStaffLike(principal)
        ? (input.payerPersonId ?? trialPayer ?? familyRegistrant)
        : (resolveCustomerPayer(principal, input.payerPersonId, [principal.personId]) ??
          principal.personId);
      const ownerPersonId = isStaffLike(principal) ? payerPersonId : principal.personId;
      if (!ownerPersonId)
        throw errors.validation('payerPersonId is required when staff open a follow-up.', {
          path: 'payerPersonId',
        });
      const owner = await this.evaluator.participant(trx, organizationId, ownerPersonId);
      if (owner.kind !== 'adult')
        throw errors.validation('A basket belongs to an adult household member.');
      const equivalence = this.evaluator.equivalence(snapshot, person.id);
      if (
        await this.enrollments.findEquivalentActive(trx, organizationId, person.id, equivalence)
      ) {
        throw errors.duplicateEntitlement(
          'An equivalent active registration already exists for this participant.',
          {
            participantPersonId: person.id,
            offeringId: snapshot.offering.id,
          },
        );
      }
      let application = this.applications.forIntent(
        await this.applications.findCurrent(trx, organizationId, snapshot.offering.id, person.id, [
          principal.personId,
          owner.id,
          payerPersonId,
        ]),
        input.intent,
      );
      if (!application) {
        application = await this.applications.createInTrx(trx, organizationId, {
          snapshot,
          person,
          intent: input.intent,
          evaluation,
          payerPersonId,
          teamEntryId: null,
          sessionId: null,
          notes: null,
          actor: principal,
          correlationId,
        });
      }
      const opened = await this.baskets.openForLine(trx, organizationId, {
        owner,
        payerPersonId,
        actor: principal,
        participant: person,
        snapshot,
        intent: input.intent,
        sessionId: null,
        evaluation,
        applicationId: application.id,
        trialParticipationId: row.id,
        correlationId,
      });
      await trx
        .updateTable('trial_participations')
        .set({
          converted_basket_id: opened.basket.id,
          follow_up: json({
            suggestedOfferingIds: [snapshot.offering.id],
            basketId: opened.basket.id,
          }),
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'enrollment.convert_trial',
        targetType: 'trial_participation',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        correlationId,
        details: {
          targetOfferingId: snapshot.offering.id,
          basketId: opened.basket.id,
          charged: false,
          enrolled: false,
        },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.trialChanged, {
        organizationId,
        aggregateType: 'trial_participation',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          trialParticipationId: id,
          status: row.status,
          convertedEnrollmentId: null,
          convertedBasketId: opened.basket.id,
        },
      });
      const basket = await this.baskets.getBasket(organizationId, opened.basket.id, trx);
      return {
        trial: toTrialParticipation((await this.load(trx, organizationId, id))!),
        basket: basket!,
      };
    });
  }
}
