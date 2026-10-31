import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors, type Principal } from '@sportspark/contracts';
import { AuthorizationService, type ActionDefinition, type Trx } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';

/**
 * Every person id whose financial facts are `personId`'s: identity's
 * `PersonDirectoryPort.personIdsResolvingTo` (ID-01, IF-09, SPK-IAM-007), or `[personId]` for an
 * id it does not know. While that port member is still declared but not implemented (a branch
 * without ID-01), the answer is the person's own id only: exactly what finance read before merges
 * were resolvable, so no read fails and nothing is inferred about merged records. Any other
 * failure propagates.
 */
export async function personIdsOf(
  persons: PersonDirectoryPort,
  organizationId: string,
  personId: string,
  trx?: Trx,
): Promise<string[]> {
  try {
    const ids = await persons.personIdsResolvingTo(organizationId, personId, trx);
    return ids.length > 0 ? ids : [personId];
  } catch (error) {
    if (
      DomainError.is(error) &&
      error.code === 'INTERNAL_ERROR' &&
      /declared but not implemented/.test(error.message)
    ) {
      return [personId];
    }
    throw error;
  }
}

/**
 * Whose money a person's own lists show (FIN-01; K-05 customerSubjects, ID-01
 * personIdsResolvingTo; SPK-IAM-003, SPK-IAM-007): themselves when the action allows self, and
 * every person they currently hold the action's permission over, never anyone through a staff
 * role. Each subject is expanded to every person id that resolves to it, so the history of a
 * merged duplicate shows under the survivor without any financial row being rewritten.
 */
@Injectable()
export class FinanceCustomerScope {
  constructor(
    private readonly authorization: AuthorizationService,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  /** The person ids the caller's list for `action` covers (sorted; empty for a person-less caller). */
  async subjectIds(principal: Principal, action: ActionDefinition): Promise<string[]> {
    if (!principal.organizationId || principal.kind === 'anonymous') {
      throw errors.authenticationRequired();
    }
    if (!principal.personId) return [];
    const subjects = await this.authorization.customerSubjects(principal, action);
    const ids = new Set<string>();
    for (const subject of subjects) {
      for (const id of await personIdsOf(this.persons, principal.organizationId, subject)) {
        ids.add(id);
      }
    }
    return [...ids].sort();
  }

  /** The caller and every id merged into them (records they made themselves). */
  async selfIds(principal: Principal): Promise<string[]> {
    if (!principal.organizationId || principal.kind === 'anonymous') {
      throw errors.authenticationRequired();
    }
    if (!principal.personId) return [];
    return personIdsOf(this.persons, principal.organizationId, principal.personId);
  }

  /**
   * Every person id whose credits or debts are `personId`'s (the survivor and every record merged
   * into it, SPK-IAM-007, R2-LIFECYCLES-02): a merge rewrites no financial row, so finance
   * compares a stored owner or debtor with this set instead of one id.
   */
  idsOf(organizationId: string, personId: string, trx?: Trx): Promise<string[]> {
    return personIdsOf(this.persons, organizationId, personId, trx);
  }

  /**
   * The authorization subject for a stored owner, debtor or responsible payer (SPK-IAM-007,
   * R2-LIFECYCLES-02): the surviving record when the stored one was merged. A merge moves the
   * relationships and grants to the survivor, so the people who hold authority over the person now
   * hold it over the survivor; the merged id itself has none left. Unknown ids answer themselves.
   */
  async subjectOf(organizationId: string, personId: string, trx?: Trx): Promise<string> {
    return canonicalPersonIdOf(this.persons, organizationId, personId, trx);
  }
}

/**
 * The surviving record of `personId` (PersonDirectoryPort.resolveCanonicalPersonId; SPK-IAM-007),
 * or `personId` itself while that member is declared but not implemented, as `personIdsOf`.
 */
export async function canonicalPersonIdOf(
  persons: PersonDirectoryPort,
  organizationId: string,
  personId: string,
  trx?: Trx,
): Promise<string> {
  try {
    return await persons.resolveCanonicalPersonId(organizationId, personId, trx);
  } catch (error) {
    if (
      DomainError.is(error) &&
      error.code === 'INTERNAL_ERROR' &&
      /declared but not implemented/.test(error.message)
    ) {
      return personId;
    }
    throw error;
  }
}
