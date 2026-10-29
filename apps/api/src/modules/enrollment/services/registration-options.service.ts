import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  PUBLIC_PUBLICATION_STATES,
  RegistrationIntentSchema,
  errors,
  type Principal,
  type RegistrationOptions,
} from '@sportspark/contracts';
import { AuthorizationService } from '../../../kernel';
import { TEAM_ENTRY_QUERY_PORT, type TeamEntryQueryPort } from '../../competition';
import { EnrollmentActions } from '../enrollment.actions';
import { INTENT_OFFERING_KINDS } from '../enrollment.policy';
import { isStaffLike, organizationOf } from '../enrollment.shared';
import { CustomerScope } from './customer-scope';
import { EnrollmentFacilityScope } from './facility-scope';
import { RegistrationEvaluator } from './registration-evaluator';

/**
 * Registration options of an offering (ENR-05; SPK-REG-001, SPK-REG-002, SPK-PLACE-001, SCR-C-08,
 * SCR-C-10): the intents it accepts (INTENT_OFFERING_KINDS), the competition season an individual
 * registrant's placement request names, and, for each named participant the caller may register,
 * each intent's eligibility. The evaluation is the registration evaluator's, run read-only: no
 * hold, basket, application or other write, and unknown evidence stays unknown (never a pass).
 * People the caller may not register are omitted, never reported; customers see published
 * offerings only (else protected NOT_FOUND, §4.10).
 */
@Injectable()
export class RegistrationOptionsService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly evaluator: RegistrationEvaluator,
    private readonly customers: CustomerScope,
    private readonly scope: EnrollmentFacilityScope,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly teamEntries: TeamEntryQueryPort,
  ) {}

  async options(
    principal: Principal,
    offeringId: string,
    participantPersonIds: readonly string[],
  ): Promise<RegistrationOptions> {
    const organizationId = organizationOf(principal);
    const snapshot = await this.evaluator
      .snapshot(undefined, organizationId, offeringId)
      .catch((error: unknown) => {
        if (DomainError.is(error) && error.code === 'NOT_FOUND') {
          throw errors.protectedNotFound('offering');
        }
        throw error;
      });
    const facilityId = snapshot.offering.facilityId;
    // Staff with the apply roles (at the offering's facility) may name anyone; otherwise only the
    // people the caller holds `register` over, and a published offering.
    const staffMayApply =
      isStaffLike(principal) &&
      (
        await this.authorization.decide(principal, EnrollmentActions.apply, {
          type: 'application',
          organizationId,
          facilityId,
        })
      ).allowed;
    if (!staffMayApply && !PUBLIC_PUBLICATION_STATES.includes(snapshot.offering.publicationState)) {
      throw errors.protectedNotFound('offering');
    }
    const permitted = staffMayApply
      ? null
      : new Set(
          principal.personId
            ? await this.customers.subjectIds(principal, EnrollmentActions.apply)
            : [],
        );
    const availableIntents = RegistrationIntentSchema.options.filter((intent) =>
      INTENT_OFFERING_KINDS[intent].includes(snapshot.offering.kind),
    );
    const season = await this.teamEntries.seasonForOffering(organizationId, offeringId);
    const participants: RegistrationOptions['participants'] = [];
    for (const personId of participantPersonIds) {
      if (permitted && !permitted.has(personId)) continue;
      const person = await this.evaluator.participantOrNull(undefined, organizationId, personId);
      if (!person) continue;
      if (!permitted) {
        // §4.3: a facility-scoped staff member names participants of their facilities' offerings.
        await this.scope.requireAt(
          principal,
          EnrollmentActions.apply,
          { type: 'application', organizationId, subjectPersonIds: [person.id] },
          [facilityId],
        );
      }
      const intents: RegistrationOptions['participants'][number]['intents'] = [];
      for (const intent of availableIntents) {
        const evaluation = await this.evaluator.evaluate(undefined, organizationId, {
          snapshot,
          person,
          intent,
        });
        intents.push({ intent, eligibility: evaluation.result });
      }
      participants.push({ personId: person.id, intents });
    }
    return {
      offeringId: snapshot.offering.id,
      availableIntents,
      seasonId: season?.seasonId ?? null,
      participants,
    };
  }
}
