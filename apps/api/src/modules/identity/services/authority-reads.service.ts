import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  z,
  type GrantView,
  type ListMyAccessGrantsQueryInput,
  type MyHousehold,
  type Page,
  type PersonAuthority,
  type Principal,
} from '@sportspark/contracts';
import type { AccessGrantsTable, Db, RelationshipsTable } from '@sportspark/db';
import { sql, type Selectable, type SqlBool } from 'kysely';
import { AuthorizationService, CLOCK, DATABASE, type Clock, type Trx } from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import {
  displayNameOf,
  displayNamesOf,
  iso,
  isoOrNull,
  isSuspendedAt,
  maskContactValue,
  toRelationship,
} from '../identity.shared';
import { InvitationsService } from './invitations.service';
import { RelationshipAuthority } from './relationship-authority.service';

const ListCursor = z.object({ c: z.iso.datetime(), id: z.uuid() });

/** At most this many grants and relationships are returned on one person's authority read. */
const AUTHORITY_ROWS = 500;

type GrantRow = Selectable<AccessGrantsTable> & {
  relationship_kind: Selectable<RelationshipsTable>['kind'];
  relationship_status: Selectable<RelationshipsTable>['status'];
  relationship_effective_from: Selectable<RelationshipsTable>['effective_from'];
  relationship_effective_to: Selectable<RelationshipsTable>['effective_to'];
};

const ms = (value: Date | string) => new Date(value).getTime();

/**
 * A grant's state at `now` (ID-04, SPK-IAM-003/005/006). `effective` is exactly the rule
 * RelationshipAuthority.hasPermission applies: unrevoked, not suspended, inside its own and its
 * relationship's dates, on an active relationship.
 */
export function grantStatus(row: GrantRow, now: Date): GrantView['status'] {
  const t = now.getTime();
  if (row.revoked_at !== null) return 'revoked';
  if (row.relationship_status === 'ended') return 'ended';
  const ends = [row.effective_to, row.relationship_effective_to].filter(
    (v): v is Date => v !== null,
  );
  if (ends.some((end) => ms(end) <= t)) return 'ended';
  if (ms(row.effective_from) > t || ms(row.relationship_effective_from) > t) return 'scheduled';
  if (isSuspendedAt(row, now) || row.relationship_status === 'suspended') return 'suspended';
  return 'effective';
}

/**
 * Authority reads (ID-04, SPK-IAM-001/003/005/006, §4.14): a holder's own grants with their ids,
 * sources, dates and state; staff's view of one person's authority (SCR-S-20/21); and the
 * households a customer belongs to, showing only the members they may view. Household membership
 * is shown as grouping only and never implies authority (§4.5).
 */
@Injectable()
export class AuthorityReadsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly invitations: InvitationsService,
    private readonly authority: RelationshipAuthority,
  ) {}

  /**
   * GET /v1/me/access-grants (SPK-IAM-006): `held` lists the grants I hold over others, `over_me`
   * the grants others hold over me (DEC-004 pending: other adults' grants over a child I manage
   * are not shown). Each names its id, relationship, source, dates and state, and whether a
   * disputed-access review restricts it (SPK-IAM-005 "under review"). Keyset (created_at desc).
   */
  async myAccessGrants(
    principal: Principal,
    query: ListMyAccessGrantsQueryInput,
  ): Promise<Page<GrantView>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const me = principal.personId;
    if (!me) return { items: [], nextCursor: null };
    await this.authorization.require(principal, IdentityActions.readPerson, {
      type: 'person',
      id: me,
      organizationId,
      subjectPersonIds: [me],
      protected: true,
    });
    const column =
      (query.direction ?? 'held') === 'held'
        ? 'access_grants.actor_person_id'
        : 'access_grants.subject_person_id';
    let rows = this.grantRows(this.db, organizationId).where(column, '=', me);
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (cursor) {
      rows = rows.where(
        sql<SqlBool>`(access_grants.created_at, access_grants.id) < (${new Date(cursor.c)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const found = (await rows
      .orderBy('access_grants.created_at', 'desc')
      .orderBy('access_grants.id', 'desc')
      .limit(query.limit + 1)
      .execute()) as GrantRow[];
    const page = found.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: await this.grantViews(this.db, organizationId, page),
      nextCursor:
        found.length > query.limit && last
          ? encodeCursor({ c: iso(last.created_at), id: last.id })
          : null,
    };
  }

  /**
   * GET /v1/people/{id}/authority (identity.read_authority): the person's relationships and grants
   * in both directions, households with member counts, pending invitations that concern them,
   * whether an active account represents them and their claims (never the token; the recipient
   * masked), so staff see whether a staff-entered person is claimable or claimed (SCR-S-20).
   * Anyone without the action gets a protected NOT_FOUND (§4.10).
   */
  async personAuthority(principal: Principal, personId: string): Promise<PersonAuthority> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const person = await this.db
      .selectFrom('persons')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (!person) throw errors.protectedNotFound('person');
    await this.authorization.require(principal, IdentityActions.readAuthority, {
      type: 'person',
      id: personId,
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    const now = this.clock.now();
    const relationships = await this.db
      .selectFrom('relationships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where((eb) =>
        eb.or([eb('actor_person_id', '=', personId), eb('subject_person_id', '=', personId)]),
      )
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(AUTHORITY_ROWS)
      .execute();
    const grants = (await this.grantRows(this.db, organizationId)
      .where((eb) =>
        eb.or([
          eb('access_grants.actor_person_id', '=', personId),
          eb('access_grants.subject_person_id', '=', personId),
        ]),
      )
      .orderBy('access_grants.created_at', 'desc')
      .orderBy('access_grants.id', 'desc')
      .limit(AUTHORITY_ROWS)
      .execute()) as GrantRow[];
    const households = await this.db
      .selectFrom('household_memberships as mine')
      .innerJoin('households', (join) =>
        join
          .onRef('households.organization_id', '=', 'mine.organization_id')
          .onRef('households.id', '=', 'mine.household_id'),
      )
      .select((eb) => [
        'households.id',
        'households.name',
        eb
          .selectFrom('household_memberships as all_members')
          .select((inner) => inner.fn.countAll<number>().as('n'))
          .whereRef('all_members.organization_id', '=', 'households.organization_id')
          .whereRef('all_members.household_id', '=', 'households.id')
          .as('member_count'),
      ])
      .where('mine.organization_id', '=', organizationId)
      .where('mine.person_id', '=', personId)
      .orderBy('households.name')
      .orderBy('households.id')
      .execute();
    const account = await this.db
      .selectFrom('accounts')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const claims = await this.db
      .selectFrom('claims')
      .select([
        'id',
        'kind',
        'status',
        'expires_at',
        'created_at',
        'recipient_contact_kind',
        'recipient_contact_value',
      ])
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', '=', personId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(AUTHORITY_ROWS)
      .execute();
    return {
      personId,
      relationships: relationships.map(toRelationship),
      grants: await this.grantViews(this.db, organizationId, grants),
      households: households.map((h) => ({
        id: h.id,
        name: h.name,
        memberCount: Number(h.member_count ?? 0),
      })),
      pendingInvitations: await this.invitations.pendingConcerning(
        this.db,
        organizationId,
        personId,
      ),
      accountLinked: account !== undefined,
      claims: claims.map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        effectiveStatus:
          c.status === 'pending' && ms(c.expires_at) <= now.getTime() ? 'expired' : c.status,
        expiresAt: iso(c.expires_at),
        createdAt: iso(c.created_at),
        recipientHint:
          c.recipient_contact_kind && c.recipient_contact_value
            ? maskContactValue(c.recipient_contact_kind, c.recipient_contact_value)
            : null,
      })),
    };
  }

  /**
   * GET /v1/me/households (SPK-IAM-001, §4.5, §4.14): the households I belong to. Members are
   * limited to myself and the people I hold view over now; the rest are counted, never named.
   */
  async myHouseholds(principal: Principal): Promise<MyHousehold[]> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const me = principal.personId;
    if (!me) return [];
    await this.authorization.require(principal, IdentityActions.readPerson, {
      type: 'person',
      id: me,
      organizationId,
      subjectPersonIds: [me],
      protected: true,
    });
    const households = await this.db
      .selectFrom('household_memberships')
      .innerJoin('households', (join) =>
        join
          .onRef('households.organization_id', '=', 'household_memberships.organization_id')
          .onRef('households.id', '=', 'household_memberships.household_id'),
      )
      .selectAll('households')
      .where('household_memberships.organization_id', '=', organizationId)
      .where('household_memberships.person_id', '=', me)
      .orderBy('households.name')
      .orderBy('households.id')
      .execute();
    if (households.length === 0) return [];
    const members = await this.db
      .selectFrom('household_memberships')
      .innerJoin('persons', (join) =>
        join
          .onRef('persons.organization_id', '=', 'household_memberships.organization_id')
          .onRef('persons.id', '=', 'household_memberships.person_id'),
      )
      .select([
        'household_memberships.household_id',
        'household_memberships.person_id',
        'household_memberships.label',
        'household_memberships.created_at',
        'persons.given_name',
        'persons.family_name',
        'persons.kind',
      ])
      .where('household_memberships.organization_id', '=', organizationId)
      .where(
        'household_memberships.household_id',
        'in',
        households.map((h) => h.id),
      )
      .orderBy('household_memberships.created_at')
      .orderBy('household_memberships.person_id')
      .execute();
    const viewable = new Set(
      await this.authority.subjectsWithPermission(organizationId, me, 'view'),
    );
    return households.map((household) => {
      const own = members.filter((m) => m.household_id === household.id);
      const shown = own.filter((m) => m.person_id === me || viewable.has(m.person_id));
      return {
        id: household.id,
        name: household.name,
        members: shown.map((m) => ({
          personId: m.person_id,
          displayName: displayNameOf(m.given_name, m.family_name),
          kind: m.kind,
          label: m.label,
          isSelf: m.person_id === me,
        })),
        otherMemberCount: own.length - shown.length,
        revision: household.revision,
        createdAt: iso(household.created_at),
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  private grantRows(db: Db | Trx, organizationId: string) {
    return db
      .selectFrom('access_grants')
      .innerJoin('relationships', (join) =>
        join
          .onRef('relationships.organization_id', '=', 'access_grants.organization_id')
          .onRef('relationships.id', '=', 'access_grants.relationship_id'),
      )
      .selectAll('access_grants')
      .select([
        'relationships.kind as relationship_kind',
        'relationships.status as relationship_status',
        'relationships.effective_from as relationship_effective_from',
        'relationships.effective_to as relationship_effective_to',
      ])
      .where('access_grants.organization_id', '=', organizationId);
  }

  private async grantViews(
    db: Db | Trx,
    organizationId: string,
    rows: GrantRow[],
  ): Promise<GrantView[]> {
    const now = this.clock.now();
    const names = await displayNamesOf(
      db,
      organizationId,
      rows.flatMap((r) => [r.actor_person_id, r.subject_person_id]),
    );
    return rows.map((row) => ({
      grantId: row.id,
      relationshipId: row.relationship_id,
      relationshipKind: row.relationship_kind,
      actorPersonId: row.actor_person_id,
      actorDisplayName: names.get(row.actor_person_id) ?? null,
      subjectPersonId: row.subject_person_id,
      subjectDisplayName: names.get(row.subject_person_id) ?? null,
      permission: row.permission,
      source: row.source,
      effectiveFrom: iso(row.effective_from),
      effectiveTo: isoOrNull(row.effective_to),
      revokedAt: isoOrNull(row.revoked_at),
      status: grantStatus(row, now),
      underReview: row.revoked_at === null && isSuspendedAt(row, now),
      revision: row.revision,
    }));
  }
}
