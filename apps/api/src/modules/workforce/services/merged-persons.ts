import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';

/**
 * Person merges as workforce reads them (WRK-05, SPK-IAM-007, IF-09, §4.2): workforce never
 * rewrites a person id in its availability, qualifications or assignments. Reads about a person
 * expand to everyone identity resolves to the same canonical person, so a qualification verified
 * for the merged person counts for the survivor. Reads go through the caller's transaction when it
 * passes one (otherwise the person directory joins the active transaction).
 */
@Injectable()
export class MergedPersons {
  constructor(@Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort) {}

  /** `[canonical, ...merged into it]`, or `[personId]` when identity does not know the id. */
  async resolving(db: Db | Trx, organizationId: string, personId: string): Promise<string[]> {
    const ids = await this.people.personIdsResolvingTo(organizationId, personId, transactionOf(db));
    return ids.length > 0 ? ids : [personId];
  }

  /** The surviving person an id resolves to (the id itself when it was never merged). */
  async canonical(db: Db | Trx, organizationId: string, personId: string): Promise<string> {
    return this.people.resolveCanonicalPersonId(organizationId, personId, transactionOf(db));
  }
}

function transactionOf(db: Db | Trx): Trx | undefined {
  return db.isTransaction ? (db as Trx) : undefined;
}
