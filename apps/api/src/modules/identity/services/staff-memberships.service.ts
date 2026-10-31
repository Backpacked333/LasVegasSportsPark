import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  z,
  type CreateStaffMembershipInput,
  type ListStaffMembershipsQueryInput,
  type Page,
  type Principal,
  type StaffDirectoryEntry,
  type StaffDirectoryQueryInput,
  type StaffMembership,
  type StaffMembershipView,
  type StaffRole,
  type UpdateStaffMembershipInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql, type SqlBool } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  ensureUpdated,
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { StaffMembershipMachine } from '../identity.machines';
import type { StaffDirectoryPort } from '../identity.ports';
import { displayNameOf, displayNamesOf, iso, toStaffMembership } from '../identity.shared';

const ListCursor = z.object({ c: z.iso.datetime(), id: z.uuid() });
const DirectoryCursor = z.object({ f: z.string(), g: z.string(), id: z.uuid() });

/** Roles listed in the staff directory only for staffing readers (SCR-S-32/33, ID-05). */
const WORKFORCE_ROLES: ReadonlySet<StaffRole> = new Set<StaffRole>(['coach', 'official']);

/**
 * Staff memberships (§2.1, §4.14). Time-bounded role assignments managed only by system
 * administrators; the principal resolver reads them at request time, so ending a membership
 * removes staff authority on the next request without touching any guardian grant.
 */
@Injectable()
export class StaffMembershipsService implements StaffDirectoryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async create(
    principal: Principal,
    input: CreateStaffMembershipInput,
    correlationId: string | null,
  ): Promise<StaffMembership> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageStaffMembership, {
      type: 'staff_membership',
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      const person = await trx
        .selectFrom('persons')
        .select(['kind', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.personId)
        .executeTakeFirst();
      if (!person) throw errors.notFound('person', input.personId);
      if (person.status !== 'active' || person.kind !== 'adult') {
        throw errors.validation('Staff memberships require an active adult person.');
      }
      await this.assertFacilities(trx, organizationId, input.facilityIds);
      const now = this.clock.now();
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
      const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
      if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
        throw errors.validation('effectiveTo must be after effectiveFrom.');
      }
      const id = newId();
      await trx
        .insertInto('staff_memberships')
        .values({
          id,
          organization_id: organizationId,
          person_id: input.personId,
          roles: input.roles,
          facility_ids: input.facilityIds,
          effective_from: effectiveFrom,
          effective_to: effectiveTo,
          ended_at: null,
          ended_reason: null,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffMembership.id,
        targetType: 'staff_membership',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'create', personId: input.personId, roles: input.roles },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffMembershipChanged, {
        organizationId,
        aggregateType: 'staff_membership',
        aggregateId: id,
        payload: {
          membershipId: id,
          personId: input.personId,
          status: 'active',
          roles: input.roles,
        },
        correlationId,
      });
      return this.load(trx, organizationId, id);
    });
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateStaffMembershipInput,
    correlationId: string | null,
  ): Promise<StaffMembership> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageStaffMembership, {
      type: 'staff_membership',
      id,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: locked so concurrent changes to one membership are serialized.
      const current = await trx
        .selectFrom('staff_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('staff_membership', id);
      assertExpectedRevision(input.expectedRevision, current.revision);
      if (current.status !== 'active') {
        throw errors.invalidTransition('StaffMembership', current.status, 'update');
      }
      if (input.facilityIds) await this.assertFacilities(trx, organizationId, input.facilityIds);
      const effectiveTo =
        input.effectiveTo === undefined
          ? current.effective_to
          : input.effectiveTo === null
            ? null
            : new Date(input.effectiveTo);
      if (
        effectiveTo &&
        new Date(effectiveTo).getTime() <= new Date(current.effective_from).getTime()
      ) {
        throw errors.validation('effectiveTo must be after effectiveFrom.');
      }
      const updated = await trx
        .updateTable('staff_memberships')
        .set({
          roles: input.roles ?? current.roles,
          facility_ids: input.facilityIds ?? current.facility_ids,
          effective_to: effectiveTo,
          revision: current.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(current.revision, current.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffMembership.id,
        targetType: 'staff_membership',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'update', roles: input.roles ?? current.roles },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffMembershipChanged, {
        organizationId,
        aggregateType: 'staff_membership',
        aggregateId: id,
        payload: {
          membershipId: id,
          personId: current.person_id,
          status: 'active',
          roles: input.roles ?? current.roles,
        },
        correlationId,
      });
      return this.load(trx, organizationId, id);
    });
  }

  async end(
    principal: Principal,
    id: string,
    input: { reason: string; expectedRevision?: number },
    correlationId: string | null,
  ): Promise<StaffMembership> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageStaffMembership, {
      type: 'staff_membership',
      id,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: locked so concurrent changes to one membership are serialized.
      const current = await trx
        .selectFrom('staff_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('staff_membership', id);
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = StaffMembershipMachine.next(current.status, 'end');
      const now = this.clock.now();
      const cap =
        current.effective_to && new Date(current.effective_to).getTime() < now.getTime()
          ? new Date(current.effective_to)
          : now;
      // SPK-STAFF-004, SPK-IAM-006: a membership ended before it started gets the empty window
      // [effective_from, effective_from), which never grants anything (the 0100 check allows it).
      const neverEffective = cap.getTime() < new Date(current.effective_from).getTime();
      const effectiveTo = neverEffective ? new Date(current.effective_from) : cap;
      const ended = await trx
        .updateTable('staff_memberships')
        .set({
          status: next,
          ended_at: now,
          ended_reason: input.reason,
          effective_to: effectiveTo,
          revision: current.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(ended.numUpdatedRows, () =>
        errors.staleRevision(current.revision, current.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffMembership.id,
        targetType: 'staff_membership',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
        details: { operation: 'end', ...(neverEffective ? { neverEffective: true } : {}) },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffMembershipChanged, {
        organizationId,
        aggregateType: 'staff_membership',
        aggregateId: id,
        payload: {
          membershipId: id,
          personId: current.person_id,
          status: 'ended',
          roles: current.roles,
        },
        correlationId,
      });
      return this.load(trx, organizationId, id);
    });
  }

  /**
   * One membership, or null. Reads through the active transaction when called from another
   * module's command or handler (executorFor), so it sees that transaction's own writes.
   */
  async find(organizationId: string, id: string): Promise<StaffMembership | null> {
    const row = await executorFor(this.db)
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toStaffMembership(row) : null;
  }

  async listForPerson(organizationId: string, personId: string): Promise<StaffMembership[]> {
    const rows = await executorFor(this.db)
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .orderBy('effective_from', 'desc')
      .execute();
    return rows.map(toStaffMembership);
  }

  /**
   * GET /v1/staff-memberships (ID-05, §2.1, §4.14, SCR-S-46): administrators list memberships by
   * person, role, facility (scoped to it or organization-wide) and status, newest first (keyset
   * created_at desc, id desc).
   */
  async list(
    principal: Principal,
    query: ListStaffMembershipsQueryInput,
  ): Promise<Page<StaffMembershipView>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.readStaffMembership, {
      type: 'staff_membership',
      organizationId,
    });
    let rows = this.db
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId);
    if (query.personId) rows = rows.where('person_id', '=', query.personId);
    if (query.role) rows = rows.where(sql<SqlBool>`${query.role} = any(roles)`);
    if (query.facilityId) {
      rows = rows.where(
        sql<SqlBool>`(cardinality(facility_ids) = 0 or ${query.facilityId}::uuid = any(facility_ids))`,
      );
    }
    if (query.status) rows = rows.where('status', '=', query.status);
    const cursor = decodeCursor(query.cursor, ListCursor);
    if (cursor) {
      rows = rows.where(
        sql<SqlBool>`(created_at, id) < (${new Date(cursor.c)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const found = await rows
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = found.slice(0, query.limit);
    const names = await displayNamesOf(
      this.db,
      organizationId,
      page.map((r) => r.person_id),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        ...toStaffMembership(r),
        personDisplayName: names.get(r.person_id) ?? null,
      })),
      nextCursor:
        found.length > query.limit && last
          ? encodeCursor({ c: iso(last.created_at), id: last.id })
          : null,
    };
  }

  /** GET /v1/staff-memberships/{id} (ID-05): one membership, e.g. to reload after STALE_REVISION. */
  async get(principal: Principal, id: string): Promise<StaffMembershipView> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.readStaffMembership, {
      type: 'staff_membership',
      id,
      organizationId,
    });
    const row = await this.db
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('staff_membership', id);
    const names = await displayNamesOf(this.db, organizationId, [row.person_id]);
    return { ...toStaffMembership(row), personDisplayName: names.get(row.person_id) ?? null };
  }

  /**
   * GET /v1/staff-directory (ID-05, §2.1, §4.14, SPK-UX-005): people holding staff roles at the
   * clock, by the principal resolver's rule (active, effective_from <= now < effective_to), with
   * each role's own facility scope. Names and roles only, never contacts. Coach and official roles
   * are listed only for identity.read_workforce_directory (staffing screens SCR-S-32/33); without
   * it they are left out, and so is a person who holds nothing else. Sorted by family then given
   * name (keyset).
   */
  async directory(
    principal: Principal,
    query: StaffDirectoryQueryInput,
  ): Promise<Page<StaffDirectoryEntry>> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.readStaffDirectory, {
      type: 'staff_directory',
      organizationId,
    });
    const workforce = (
      await this.authorization.decide(principal, IdentityActions.readWorkforceDirectory, {
        type: 'staff_directory',
        organizationId,
      })
    ).allowed;
    const now = this.clock.now();
    const rows = await this.db
      .selectFrom('staff_memberships')
      .innerJoin('persons', (join) =>
        join
          .onRef('persons.organization_id', '=', 'staff_memberships.organization_id')
          .onRef('persons.id', '=', 'staff_memberships.person_id'),
      )
      .select([
        'staff_memberships.person_id',
        'staff_memberships.roles',
        'staff_memberships.facility_ids',
        'persons.given_name',
        'persons.family_name',
      ])
      .where('staff_memberships.organization_id', '=', organizationId)
      .where('staff_memberships.status', '=', 'active')
      .where('staff_memberships.effective_from', '<=', now)
      .where((eb) =>
        eb.or([
          eb('staff_memberships.effective_to', 'is', null),
          eb('staff_memberships.effective_to', '>', now),
        ]),
      )
      .where('persons.status', '=', 'active')
      .execute();
    interface Entry {
      personId: string;
      givenName: string;
      familyName: string;
      scopes: Map<StaffRole, { all: boolean; facilities: Set<string> }>;
    }
    const byPerson = new Map<string, Entry>();
    for (const row of rows) {
      const entry = byPerson.get(row.person_id) ?? {
        personId: row.person_id,
        givenName: row.given_name,
        familyName: row.family_name,
        scopes: new Map(),
      };
      for (const name of row.roles) {
        const role = name as StaffRole;
        if (!workforce && WORKFORCE_ROLES.has(role)) continue;
        const scope = entry.scopes.get(role) ?? { all: false, facilities: new Set<string>() };
        if (row.facility_ids.length === 0) scope.all = true;
        for (const facility of row.facility_ids) scope.facilities.add(facility);
        entry.scopes.set(role, scope);
      }
      byPerson.set(row.person_id, entry);
    }
    const term = query.query?.toLowerCase();
    const covers = (scope: { all: boolean; facilities: Set<string> }, facilityId: string) =>
      scope.all || scope.facilities.has(facilityId);
    const sortKey = (e: Entry) => ({
      f: e.familyName.toLowerCase(),
      g: e.givenName.toLowerCase(),
      id: e.personId,
    });
    const compare = (
      a: { f: string; g: string; id: string },
      b: { f: string; g: string; id: string },
    ) =>
      a.f < b.f ? -1 : a.f > b.f ? 1 : a.g < b.g ? -1 : a.g > b.g ? 1 : a.id.localeCompare(b.id);
    const cursor = decodeCursor(query.cursor, DirectoryCursor);
    const matching = [...byPerson.values()]
      .filter((e) => e.scopes.size > 0)
      .filter((e) => !query.role || e.scopes.has(query.role))
      .filter((e) => {
        if (!query.facilityId) return true;
        const facilityId = query.facilityId;
        const roles = query.role ? [query.role] : [...e.scopes.keys()];
        return roles.some((r) => {
          const scope = e.scopes.get(r);
          return scope !== undefined && covers(scope, facilityId);
        });
      })
      .filter(
        (e) =>
          !term ||
          e.givenName.toLowerCase().startsWith(term) ||
          e.familyName.toLowerCase().startsWith(term),
      )
      .sort((a, b) => compare(sortKey(a), sortKey(b)))
      .filter((e) => !cursor || compare(sortKey(e), cursor) > 0);
    const page = matching.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((e) => {
        const roles = [...e.scopes.keys()].sort();
        const all = roles.some((r) => e.scopes.get(r)?.all);
        const facilities = new Set<string>();
        for (const r of roles) for (const f of e.scopes.get(r)?.facilities ?? []) facilities.add(f);
        return {
          personId: e.personId,
          displayName: displayNameOf(e.givenName, e.familyName),
          roles,
          facilityIds: all ? [] : [...facilities].sort(),
          scopes: roles.map((role) => {
            const scope = e.scopes.get(role)!;
            return { role, facilityIds: scope.all ? [] : [...scope.facilities].sort() };
          }),
        };
      }),
      nextCursor: matching.length > query.limit && last ? encodeCursor(sortKey(last)) : null,
    };
  }

  // StaffDirectoryPort
  async staffWithRole(
    organizationId: string,
    role: StaffRole,
    facilityId?: string | null,
    trx?: Trx,
  ): Promise<string[]> {
    const now = this.clock.now();
    let query = (trx ?? executorFor(this.db))
      .selectFrom('staff_memberships')
      .select('person_id')
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .where('effective_from', '<=', now)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
      .where(sql<boolean>`${role} = any(roles)`);
    if (facilityId) {
      query = query.where(
        sql<boolean>`(cardinality(facility_ids) = 0 or ${facilityId}::uuid = any(facility_ids))`,
      );
    }
    const rows = await query.execute();
    return rows.map((r) => r.person_id);
  }

  private async assertFacilities(trx: Trx, organizationId: string, facilityIds: string[]) {
    if (facilityIds.length === 0) return;
    const rows = await trx
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', 'in', facilityIds)
      .execute();
    if (rows.length !== new Set(facilityIds).size) {
      throw errors.validation('Every facilityId must belong to this organization.', {
        facilityIds,
      });
    }
  }

  private async load(trx: Trx, organizationId: string, id: string): Promise<StaffMembership> {
    const row = await trx
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toStaffMembership(row);
  }
}
