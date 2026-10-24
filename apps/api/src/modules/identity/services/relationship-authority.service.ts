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
 * RELATIONSHIP_AUTHORITY_IMPL (SPK-IAM-003/005/006). Authority is exactly one thing: an
 * access_grants row that is unrevoked, not under a suspension in force, inside its own effective
 * dates, on a relationship that is active and inside its relationship's effective dates, evaluated
 * at the injected clock. Revocation, suspension and the end of a time-bounded relationship are
 * therefore visible on the very next check without caching. Household membership, surname or
 * shared contact points never count.
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

  /**
   * AuthorityLookupPort.hasPermissionAt: the effectivity rule evaluated at `asOf` from history —
   * revocation and relationship end times, both windows, and the append-only
   * access_grant_suspensions (migration 0103), never the suspension projection columns, which
   * describe only the present. A relationship's status change carries no time, so a caller
   * pairs this with `hasPermission` (which requires the relationship to be active now).
   */
  async hasPermissionAt(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    asOf: Date,
    trx?: Trx,
  ): Promise<boolean> {
    const db = trx ?? currentTransaction() ?? this.db;
    if (actorPersonId === subjectPersonId) {
      return this.hasPermission(organizationId, actorPersonId, subjectPersonId, permission, trx);
    }
    const row = await db
      .selectFrom('access_grants')
      .innerJoin('relationships', (join) =>
        join
          .onRef('relationships.organization_id', '=', 'access_grants.organization_id')
          .onRef('relationships.id', '=', 'access_grants.relationship_id'),
      )
      .select('access_grants.id')
      .where('access_grants.organization_id', '=', organizationId)
      .where('access_grants.actor_person_id', '=', actorPersonId)
      .where('access_grants.subject_person_id', '=', subjectPersonId)
      .where('access_grants.permission', '=', permission)
      .where((eb) =>
        eb.or([
          eb('access_grants.revoked_at', 'is', null),
          eb('access_grants.revoked_at', '>', asOf),
        ]),
      )
      .where('access_grants.effective_from', '<=', asOf)
      .where((eb) =>
        eb.or([
          eb('access_grants.effective_to', 'is', null),
          eb('access_grants.effective_to', '>', asOf),
        ]),
      )
      .where('relationships.effective_from', '<=', asOf)
      .where((eb) =>
        eb.or([
          eb('relationships.effective_to', 'is', null),
          eb('relationships.effective_to', '>', asOf),
        ]),
      )
      .where((eb) =>
        eb.or([eb('relationships.ended_at', 'is', null), eb('relationships.ended_at', '>', asOf)]),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('access_grant_suspensions as s')
              .select('s.id')
              .whereRef('s.organization_id', '=', 'access_grants.organization_id')
              .whereRef('s.grant_id', '=', 'access_grants.id')
              .where('s.suspended_at', '<=', asOf)
              .where((eb) =>
                eb.or([eb('s.suspended_until', 'is', null), eb('s.suspended_until', '>', asOf)]),
              )
              .where((eb) => eb.or([eb('s.ended_at', 'is', null), eb('s.ended_at', '>', asOf)])),
          ),
        ),
      )
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

  /**
   * Module-internal (not on AuthorityLookupPort): true only when the permission is held through a
   * relationship of kind `guardian`. Customer invitations are limited to guardians (DEC-089,
   * proposed default): a delegate or caregiver cannot hand their access on (SPK-IAM-001/003/004).
   */
  async hasPermissionAsGuardian(
    organizationId: string,
    actorPersonId: string,
    subjectPersonId: string,
    permission: GrantPermissionValue,
    trx?: Trx,
  ): Promise<boolean> {
    if (actorPersonId === subjectPersonId) return false;
    const row = await this.effectiveGrants(
      trx ?? currentTransaction() ?? this.db,
      organizationId,
      subjectPersonId,
      permission,
    )
      .where('access_grants.actor_person_id', '=', actorPersonId)
      .where('relationships.kind', '=', 'guardian')
      .select('access_grants.id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Every effective permission the actor currently holds, grouped by subject (for GET /me). */
  async authoritiesOf(
    organizationId: string,
    actorPersonId: string,
  ): Promise<Array<{ subjectPersonId: string; permissions: GrantPermissionValue[] }>> {
    const rows = await this.effectiveGrantRows(this.db, organizationId)
      .select(['access_grants.subject_person_id', 'access_grants.permission'])
      .where('access_grants.actor_person_id', '=', actorPersonId)
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
    return this.effectiveGrantRows(db, organizationId)
      .where('access_grants.subject_person_id', '=', subjectPersonId)
      .where('access_grants.permission', '=', permission);
  }

  /** The one effectivity rule, in SQL (mirrors `isGrantEffective` plus the relationship window). */
  private effectiveGrantRows(db: Db | Trx, organizationId: string) {
    const now = this.clock.now();
    return (
      db
        .selectFrom('access_grants')
        .innerJoin('relationships', (join) =>
          join
            .onRef('relationships.organization_id', '=', 'access_grants.organization_id')
            .onRef('relationships.id', '=', 'access_grants.relationship_id'),
        )
        .where('access_grants.organization_id', '=', organizationId)
        .where('access_grants.revoked_at', 'is', null)
        // SPK-IAM-005: a suspension holds until its end time (migration 0102) or a lift.
        .where((eb) =>
          eb.or([
            eb('access_grants.suspended_at', 'is', null),
            eb.and([
              eb('access_grants.suspended_until', 'is not', null),
              eb('access_grants.suspended_until', '<=', now),
            ]),
          ]),
        )
        .where('access_grants.effective_from', '<=', now)
        .where((eb) =>
          eb.or([
            eb('access_grants.effective_to', 'is', null),
            eb('access_grants.effective_to', '>', now),
          ]),
        )
        .where('relationships.status', '=', 'active')
        // SPK-IAM-003/006: the relationship's own dates bound every grant on it, whatever the
        // grant rows say (a grant added later never outlives a time-bounded relationship).
        .where('relationships.effective_from', '<=', now)
        .where((eb) =>
          eb.or([
            eb('relationships.effective_to', 'is', null),
            eb('relationships.effective_to', '>', now),
          ]),
        )
    );
  }
}
