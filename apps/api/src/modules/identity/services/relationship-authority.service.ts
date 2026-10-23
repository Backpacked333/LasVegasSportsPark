import { Inject, Injectable } from '@nestjs/common';
import type { GrantPermissionValue } from '@sportspark/db';
import type { Db } from '@sportspark/db';
import {
  CLOCK,
  DATABASE,
  type Clock,
  type RelationshipAuthorityPort,
  type Trx,
} from '../../../kernel';
import type { AuthorityLookupPort } from '../identity.ports';
import { currentTransaction } from '../identity.transaction-context';

/** Permissions a child never holds over themselves, whatever their account (SPK-IAM-003, SPK-ENTRY-007). */
export const CHILD_SELF_EXCLUDED: readonly GrantPermissionValue[] = ['pay', 'collect'];

/**
 * RELATIONSHIP_AUTHORITY_IMPL (SPK-IAM-003/006). Authority is exactly one thing: an access_grants
 * row that is unrevoked, unsuspended, inside its effective dates, on a relationship that is active,
 * evaluated at the injected clock. Revocation and suspension are therefore visible on the very next
 * check without caching. Household membership, surname or shared contact points never count.
 */
@Injectable()
export class RelationshipAuthority implements RelationshipAuthorityPort, AuthorityLookupPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async hasPermission(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    trx?: Trx,
  ): Promise<boolean> {
    const db = trx ?? currentTransaction() ?? this.db;
    if (actorPersonId === subjectPersonId) {
      const self = await db
        .selectFrom('persons')
        .select(['kind', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', actorPersonId)
        .executeTakeFirst();
      if (!self || self.status !== 'active') return false;
      if (self.kind === 'adult') return true;
      return !CHILD_SELF_EXCLUDED.includes(permission);
    }
    const row = await this.effectiveGrants(db, organizationId, subjectPersonId, permission)
      .where('access_grants.actor_person_id', '=', actorPersonId)
      .select('access_grants.id')
      .executeTakeFirst();
    return row !== undefined;
  }

  async actorsWithPermission(
    organizationId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    trx?: Trx,
  ): Promise<string[]> {
    const rows = await this.effectiveGrants(
      trx ?? currentTransaction() ?? this.db,
      organizationId,
      subjectPersonId,
      permission,
    )
      .select('access_grants.actor_person_id')
      .distinct()
      .execute();
    return rows.map((r) => r.actor_person_id);
  }

  /** Every effective permission the actor currently holds, grouped by subject (for GET /me). */
  async authoritiesOf(
    organizationId: string,
    actorPersonId: string,
  ): Promise<Array<{ subjectPersonId: string; permissions: GrantPermissionValue[] }>> {
    const now = this.clock.now();
    const rows = await this.db
      .selectFrom('access_grants')
      .innerJoin('relationships', (join) =>
        join
          .onRef('relationships.organization_id', '=', 'access_grants.organization_id')
          .onRef('relationships.id', '=', 'access_grants.relationship_id'),
      )
      .select(['access_grants.subject_person_id', 'access_grants.permission'])
      .where('access_grants.organization_id', '=', organizationId)
      .where('access_grants.actor_person_id', '=', actorPersonId)
      .where('access_grants.revoked_at', 'is', null)
      .where('access_grants.suspended_at', 'is', null)
      .where('access_grants.effective_from', '<=', now)
      .where((eb) =>
        eb.or([
          eb('access_grants.effective_to', 'is', null),
          eb('access_grants.effective_to', '>', now),
        ]),
      )
      .where('relationships.status', '=', 'active')
      .orderBy('access_grants.subject_person_id')
      .orderBy('access_grants.permission')
      .execute();
    const bySubject = new Map<string, Set<GrantPermissionValue>>();
    for (const row of rows) {
      const set = bySubject.get(row.subject_person_id) ?? new Set<GrantPermissionValue>();
      set.add(row.permission);
      bySubject.set(row.subject_person_id, set);
    }
    return [...bySubject.entries()].map(([subjectPersonId, permissions]) => ({
      subjectPersonId,
      permissions: [...permissions],
    }));
  }

  private effectiveGrants(
    db: Db | Trx,
    organizationId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
  ) {
    const now = this.clock.now();
    return db
      .selectFrom('access_grants')
      .innerJoin('relationships', (join) =>
        join
          .onRef('relationships.organization_id', '=', 'access_grants.organization_id')
          .onRef('relationships.id', '=', 'access_grants.relationship_id'),
      )
      .where('access_grants.organization_id', '=', organizationId)
      .where('access_grants.subject_person_id', '=', subjectPersonId)
      .where('access_grants.permission', '=', permission)
      .where('access_grants.revoked_at', 'is', null)
      .where('access_grants.suspended_at', 'is', null)
      .where('access_grants.effective_from', '<=', now)
      .where((eb) =>
        eb.or([
          eb('access_grants.effective_to', 'is', null),
          eb('access_grants.effective_to', '>', now),
        ]),
      )
      .where('relationships.status', '=', 'active');
  }
}
