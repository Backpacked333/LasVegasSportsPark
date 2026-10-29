import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import type { Trx } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';

/**
 * Whose rows a person's communication reads include (COM-05; SPK-IAM-007, IF-09, IF-21): the
 * person's canonical record and everyone merged into it, through identity's
 * `personIdsResolvingTo`; nothing is ever rewritten. Identity's merge chain is consulted only when
 * a merge involves the person: they were merged into someone (their canonical id differs), or
 * this module has followed a merge into them (`communication_merge_follow_ups`). A person no merge
 * touches reads only their own rows, without the chain walk on every dispatch and inbox read.
 * Until the follow-up of a fresh merge into a survivor has run (an outbox handler, normally
 * seconds), the survivor reads only their own rows.
 */
@Injectable()
export class MergedPersons {
  constructor(@Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort) {}

  /** `[canonical, ...merged into it]`, always including `personId`. */
  async resolving(db: Db | Trx, organizationId: string, personId: string): Promise<string[]> {
    const trx = db.isTransaction ? (db as Trx) : undefined;
    const canonical = await this.persons.resolveCanonicalPersonId(organizationId, personId, trx);
    if (canonical === personId) {
      const followed = await db
        .selectFrom('communication_merge_follow_ups')
        .select('merge_id')
        .where('organization_id', '=', organizationId)
        .where('survivor_person_id', '=', personId)
        .limit(1)
        .executeTakeFirst();
      if (!followed) return [personId];
    }
    const ids = await this.persons.personIdsResolvingTo(organizationId, canonical, trx);
    if (ids.length === 0) return [personId];
    return ids.includes(personId) ? ids : [...ids, personId];
  }
}
