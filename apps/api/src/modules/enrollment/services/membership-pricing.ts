import { Inject, Injectable } from '@nestjs/common';
import type { Trx } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import type { MembershipPricingPort, MembershipPricingStanding } from '../enrollment.ports';
import { MembershipLedger } from './membership-ledger';

/**
 * MEMBERSHIP_PRICING_PORT (SPK-PAY-015, proposed amendment PA-04; DEC-098 pending): the answer
 * finance needs to decide whether a member price applies, from enrollment's own membership ledger.
 * The membership follows the participant (the proposed default), resolved through identity's
 * merge history (SPK-IAM-007) so the survivor of a merge keeps the memberships of the records
 * merged into them. Nothing is written; the caller records the answer as a fact on its quote.
 */
@Injectable()
export class MembershipPricing implements MembershipPricingPort {
  constructor(
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly ledger: MembershipLedger,
  ) {}

  async memberStanding(
    organizationId: string,
    participantPersonId: string,
    entitlementDefinitionId: string,
    at: Date,
    trx?: Trx,
  ): Promise<MembershipPricingStanding> {
    const ids = await this.persons.personIdsResolvingTo(organizationId, participantPersonId, trx);
    return this.ledger.holdsEntitlement(
      trx,
      organizationId,
      ids.length > 0 ? ids : [participantPersonId],
      entitlementDefinitionId,
      at,
    );
  }
}
