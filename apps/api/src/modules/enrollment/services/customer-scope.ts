import { Inject, Injectable } from '@nestjs/common';
import { errors, type Principal } from '@sportspark/contracts';
import { AuthorizationService, type ActionDefinition } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';

/**
 * Whose records a person's own lists show (ENR-01; K-05 customerSubjects, IF-09
 * personIdsResolvingTo; SPK-IAM-007): themselves when the action allows self, and every person
 * they currently hold the action's permission over — never anyone through a staff role. Each
 * subject is expanded to every person id that resolves to it, so a merged duplicate's history
 * shows under the survivor without any row being rewritten.
 */
@Injectable()
export class CustomerScope {
  constructor(
    private readonly authorization: AuthorizationService,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
  ) {}

  /** The person ids the caller's list for `action` covers (empty for a person-less caller). */
  async subjectIds(principal: Principal, action: ActionDefinition): Promise<string[]> {
    if (!principal.organizationId) throw errors.authenticationRequired();
    if (!principal.personId) throw errors.authenticationRequired();
    const subjects = await this.authorization.customerSubjects(principal, action);
    const ids = new Set<string>();
    for (const subject of subjects) {
      for (const id of await this.persons.personIdsResolvingTo(principal.organizationId, subject)) {
        ids.add(id);
      }
    }
    return [...ids].sort();
  }

  /** The caller themselves and every id merged into them (their own records only). */
  async selfIds(principal: Principal): Promise<string[]> {
    if (!principal.organizationId || !principal.personId) throw errors.authenticationRequired();
    const ids = await this.persons.personIdsResolvingTo(
      principal.organizationId,
      principal.personId,
    );
    return ids.length > 0 ? ids : [principal.personId];
  }
}
