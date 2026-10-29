import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ConflictUnit,
  type CreateConflictUnitBody,
  type CreateOperatingHoursBody,
  type CreateResourceBody,
  type CreateResourceConfigurationBody,
  type OperatingHours,
  type Principal,
  type Resource,
  type ResourceConfiguration,
  type UpdateResourceBody,
  type UpdateResourceConfigurationBody,
} from '@sportspark/contracts';
import {
  isExclusionViolation,
  isUniqueViolation,
  json,
  tstzrange,
  type Db,
  type ResourcesTable,
  type ResourceConfigurationsTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  UnitOfWork,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import { SchedulingActions } from '../scheduling.actions';
import { EventWriter } from './event-writer';
import { organizationOf } from './organization';

type ResourceRow = Selectable<ResourcesTable>;
type ConfigurationRow = Selectable<ResourceConfigurationsTable>;

/**
 * Physical inventory (SPK-SCHED-001/002): resources with their whole-space/subdivision
 * relationships, conflict units, configurations and operating hours. A subdivision's units are
 * added to its parent's mapping so a whole-pitch reservation conflicts with every subdivision;
 * a whole space always keeps the units of its subdivisions, and a resource that gains units has
 * them added to its active reservations that have not ended (§4.7 invariant 4).
 */
@Injectable()
export class ResourcesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly writer: EventWriter,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------------------------

  async createResource(
    principal: Principal,
    body: CreateResourceBody,
    correlationId?: string,
  ): Promise<Resource> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'resource',
        organizationId,
        facilityId: facility.id,
      });
      if (body.kind === 'subdivision' && !body.parentResourceId) {
        throw errors.validation('A subdivision needs a parent resource.', {
          path: 'parentResourceId',
        });
      }
      let parent: ResourceRow | undefined;
      if (body.parentResourceId) {
        // locked: the new subdivision's unit is added to the parent's mapping and to its holds
        parent = await this.loadResource(trx, organizationId, body.parentResourceId, true);
        if (!parent || parent.facility_id !== facility.id) {
          throw errors.validation('The parent resource must belong to the same facility.');
        }
      }
      const id = newId();
      const row = await uniqueName(
        'resource',
        trx
          .insertInto('resources')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            kind: body.kind,
            name: body.name,
            parent_resource_id: parent?.id ?? null,
            dimensions: json(body.dimensions ?? {}),
            compatible_formats: body.compatibleFormats ?? [],
            default_setup_minutes: body.defaultSetupMinutes ?? 0,
            default_cleanup_minutes: body.defaultCleanupMinutes ?? 0,
            required_equipment: json(body.requiredEquipment ?? []),
            staffing_constraints: json(body.staffingConstraints ?? {}),
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      let unitIds = body.conflictUnitIds ?? [];
      if (unitIds.length === 0) {
        const unitId = newId();
        await trx
          .insertInto('conflict_units')
          .values({
            id: unitId,
            organization_id: organizationId,
            facility_id: facility.id,
            name: body.name,
          })
          .execute();
        unitIds = [unitId];
      } else {
        await this.assertUnitsInFacility(trx, organizationId, facility.id, unitIds);
      }
      await this.mapUnits(trx, organizationId, row, unitIds);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.resource_created',
        targetType: 'resource',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
      });
      return this.resourceView(trx, row);
    });
  }

  async updateResource(
    principal: Principal,
    resourceId: string,
    body: UpdateResourceBody,
    correlationId?: string,
  ): Promise<Resource> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.loadResource(trx, organizationId, resourceId, true);
      if (!current) throw errors.notFound('resource', resourceId);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'resource',
        id: resourceId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      const updated = await trx
        .updateTable('resources')
        .set({
          name: body.name,
          dimensions: body.dimensions === undefined ? undefined : json(body.dimensions),
          compatible_formats: body.compatibleFormats,
          default_setup_minutes: body.defaultSetupMinutes,
          default_cleanup_minutes: body.defaultCleanupMinutes,
          required_equipment:
            body.requiredEquipment === undefined ? undefined : json(body.requiredEquipment),
          staffing_constraints:
            body.staffingConstraints === undefined ? undefined : json(body.staffingConstraints),
          status: body.status,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', resourceId)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      let unitChange: { from: string[]; to: string[] } | null = null;
      if (body.conflictUnitIds) {
        await this.assertUnitsInFacility(
          trx,
          organizationId,
          current.facility_id,
          body.conflictUnitIds,
        );
        // SPK-SCHED-002 / §4.7 invariant 4: conflictUnitIds names the resource's own units; a
        // whole space always keeps every unit of its subdivisions, so it still conflicts with them.
        const descendantUnits = await this.descendantUnits(trx, organizationId, resourceId);
        const effective = [...new Set([...body.conflictUnitIds, ...descendantUnits])].sort();
        const before = await this.unitsOf(trx, organizationId, resourceId);
        await trx
          .deleteFrom('resource_conflict_units')
          .where('organization_id', '=', organizationId)
          .where('resource_id', '=', resourceId)
          .execute();
        await this.mapUnits(trx, organizationId, updated, effective);
        unitChange = { from: before, to: effective };
      }
      const details: Record<string, unknown> = {};
      if (body.status && body.status !== current.status) details['status'] = body.status;
      if (unitChange && unitChange.from.join(',') !== unitChange.to.join(',')) {
        details['conflictUnitIds'] = unitChange;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.resource_updated',
        targetType: 'resource',
        targetId: resourceId,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details,
      });
      return this.resourceView(trx, updated);
    });
  }

  async getResource(principal: Principal, resourceId: string): Promise<Resource> {
    const organizationId = organizationOf(principal);
    const row = await this.loadResource(executorFor(this.db), organizationId, resourceId);
    if (!row) throw errors.notFound('resource', resourceId);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'resource',
      id: resourceId,
      organizationId,
      facilityId: row.facility_id,
    });
    return this.resourceView(executorFor(this.db), row);
  }

  async listResources(principal: Principal, facilityId: string): Promise<Resource[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'resource',
      organizationId,
      facilityId,
    });
    const rows = await executorFor(this.db)
      .selectFrom('resources')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .orderBy('name')
      .execute();
    const out: Resource[] = [];
    for (const row of rows) out.push(await this.resourceView(executorFor(this.db), row));
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Configurations
  // ---------------------------------------------------------------------------------------------

  async createConfiguration(
    principal: Principal,
    body: CreateResourceConfigurationBody,
    correlationId?: string,
  ): Promise<ResourceConfiguration> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'resource_configuration',
        organizationId,
        facilityId: facility.id,
      });
      await this.writer.loadResources(trx, organizationId, facility.id, body.memberResourceIds);
      const id = newId();
      const row = await uniqueName(
        'resource configuration',
        trx
          .insertInto('resource_configurations')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            name: body.name,
            description: body.description ?? null,
            active: body.active ?? true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      await this.setMembers(trx, organizationId, id, body.memberResourceIds);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.configuration_created',
        targetType: 'resource_configuration',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
      });
      return this.configurationView(trx, row);
    });
  }

  async updateConfiguration(
    principal: Principal,
    configurationId: string,
    body: UpdateResourceConfigurationBody,
    correlationId?: string,
  ): Promise<ResourceConfiguration> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('resource_configurations')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', configurationId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('resource configuration', configurationId);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'resource_configuration',
        id: configurationId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      if (body.memberResourceIds) {
        await this.writer.loadResources(
          trx,
          organizationId,
          current.facility_id,
          body.memberResourceIds,
        );
        await this.setMembers(trx, organizationId, configurationId, body.memberResourceIds);
      }
      const updated = await trx
        .updateTable('resource_configurations')
        .set({
          name: body.name,
          description: body.description,
          active: body.active,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', configurationId)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.configuration_updated',
        targetType: 'resource_configuration',
        targetId: configurationId,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
      });
      return this.configurationView(trx, updated);
    });
  }

  async listConfigurations(
    principal: Principal,
    facilityId: string,
  ): Promise<ResourceConfiguration[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'resource_configuration',
      organizationId,
      facilityId,
    });
    const rows = await executorFor(this.db)
      .selectFrom('resource_configurations')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .orderBy('name')
      .execute();
    const out: ResourceConfiguration[] = [];
    for (const row of rows) out.push(await this.configurationView(executorFor(this.db), row));
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Conflict units
  // ---------------------------------------------------------------------------------------------

  async createConflictUnit(
    principal: Principal,
    body: CreateConflictUnitBody,
    correlationId?: string,
  ): Promise<ConflictUnit> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'conflict_unit',
        organizationId,
        facilityId: facility.id,
      });
      const id = newId();
      const row = await uniqueName(
        'conflict unit',
        trx
          .insertInto('conflict_units')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            name: body.name,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.conflict_unit_created',
        targetType: 'conflict_unit',
        targetId: id,
        correlationId: correlationId ?? null,
      });
      return {
        id,
        facilityId: facility.id,
        name: row.name,
        resourceIds: [],
        createdAt: new Date(row.created_at).toISOString(),
      };
    });
  }

  async listConflictUnits(principal: Principal, facilityId: string): Promise<ConflictUnit[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'conflict_unit',
      organizationId,
      facilityId,
    });
    const rows = await executorFor(this.db)
      .selectFrom('conflict_units')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .orderBy('name')
      .execute();
    const mappings = await executorFor(this.db)
      .selectFrom('resource_conflict_units')
      .select(['resource_id', 'conflict_unit_id'])
      .where('organization_id', '=', organizationId)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      facilityId: row.facility_id,
      name: row.name,
      resourceIds: mappings.filter((m) => m.conflict_unit_id === row.id).map((m) => m.resource_id),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Operating hours
  // ---------------------------------------------------------------------------------------------

  async createOperatingHours(
    principal: Principal,
    body: CreateOperatingHoursBody,
    correlationId?: string,
  ): Promise<OperatingHours> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'operating_hours',
        organizationId,
        facilityId: facility.id,
      });
      if (body.resourceId) {
        await this.writer.loadResources(trx, organizationId, facility.id, [body.resourceId]);
      }
      if (body.opensAt >= body.closesAt) {
        throw errors.validation('opensAt must be before closesAt.');
      }
      const id = newId();
      const row = await uniqueName(
        'operating window',
        trx
          .insertInto('operating_hours')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            resource_id: body.resourceId ?? null,
            weekday: body.weekday,
            opens_at: body.opensAt,
            closes_at: body.closesAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.operating_hours_created',
        targetType: 'operating_hours',
        targetId: id,
        correlationId: correlationId ?? null,
      });
      return hoursView(row);
    });
  }

  async deleteOperatingHours(
    principal: Principal,
    id: string,
    correlationId?: string,
  ): Promise<{ id: string }> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await trx
        .selectFrom('operating_hours')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) throw errors.notFound('operating hours', id);
      await this.authorization.require(principal, SchedulingActions.manageInventory, {
        type: 'operating_hours',
        id,
        organizationId,
        facilityId: row.facility_id,
      });
      await trx
        .deleteFrom('operating_hours')
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.operating_hours_deleted',
        targetType: 'operating_hours',
        targetId: id,
        correlationId: correlationId ?? null,
      });
      return { id };
    });
  }

  async listOperatingHours(
    principal: Principal,
    facilityId: string,
    resourceId?: string,
  ): Promise<OperatingHours[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'operating_hours',
      organizationId,
      facilityId,
    });
    let q = executorFor(this.db)
      .selectFrom('operating_hours')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .orderBy('weekday')
      .orderBy('opens_at');
    if (resourceId) q = q.where('resource_id', '=', resourceId);
    return (await q.execute()).map(hoursView);
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  private async loadResource(
    db: Trx | Db,
    organizationId: string,
    resourceId: string,
    forUpdate = false,
  ): Promise<ResourceRow | undefined> {
    let q = db
      .selectFrom('resources')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', resourceId);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async assertUnitsInFacility(
    trx: Trx,
    organizationId: string,
    facilityId: string,
    unitIds: string[],
  ): Promise<void> {
    const rows = await trx
      .selectFrom('conflict_units')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('id', 'in', unitIds)
      .execute();
    const missing = unitIds.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) {
      throw errors.validation('Unknown conflict unit for this facility.', {
        conflictUnitIds: missing,
      });
    }
  }

  /**
   * Maps the resource to its units and propagates them up the whole-space chain (SPK-SCHED-002).
   * Every resource of the chain is locked (the caller holds the resource itself), and a unit it
   * gains is added to its active reservations that have not ended, so a hold made before the
   * inventory change still covers the space (§4.7 invariant 4).
   */
  private async mapUnits(
    trx: Trx,
    organizationId: string,
    resource: ResourceRow,
    unitIds: string[],
  ): Promise<void> {
    let current: ResourceRow | undefined = resource;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const gained: string[] = [];
      for (const unitId of new Set(unitIds)) {
        const inserted = await trx
          .insertInto('resource_conflict_units')
          .values({
            organization_id: organizationId,
            resource_id: current.id,
            conflict_unit_id: unitId,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('conflict_unit_id')
          .execute();
        if (inserted.length > 0) gained.push(unitId);
      }
      await this.extendActiveReservations(trx, organizationId, current.id, gained);
      current = current.parent_resource_id
        ? await this.loadResource(trx, organizationId, current.parent_resource_id, true)
        : undefined;
    }
  }

  /**
   * Adds the units to every active reservation of the resource whose occupied interval has not
   * ended. Units the event already holds are skipped (an update re-maps the resource's current
   * units too). If the space is already reserved by another event, the exclusion constraint
   * refuses the inventory change, reported as RESOURCE_CONFLICT naming the events.
   */
  private async extendActiveReservations(
    trx: Trx,
    organizationId: string,
    resourceId: string,
    unitIds: string[],
  ): Promise<void> {
    if (unitIds.length === 0) return;
    const reservations = await trx
      .selectFrom('reservations')
      .select([
        'id',
        'event_id',
        sql<string>`lower(occupied)`.as('start'),
        sql<string>`upper(occupied)`.as('end'),
      ])
      .where('organization_id', '=', organizationId)
      .where('resource_id', '=', resourceId)
      .where('status', '=', 'active')
      .where(sql<boolean>`upper(occupied) > ${this.clock.now()}::timestamptz`)
      .orderBy('id')
      .execute();
    for (const reservation of reservations) {
      const held = await trx
        .selectFrom('reservation_units')
        .select('conflict_unit_id')
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', reservation.event_id)
        .where('status', '=', 'active')
        .execute();
      const heldIds = new Set(held.map((h) => h.conflict_unit_id));
      const missing = unitIds.filter((u) => !heldIds.has(u));
      if (missing.length === 0) continue;
      const occupied = tstzrange(new Date(reservation.start), new Date(reservation.end));
      const colliding = await trx
        .selectFrom('reservation_units')
        .select('event_id')
        .distinct()
        .where('organization_id', '=', organizationId)
        .where('status', '=', 'active')
        .where('conflict_unit_id', 'in', missing)
        .where('event_id', '<>', reservation.event_id)
        .where(sql<boolean>`occupied && ${occupied}`)
        .execute();
      if (colliding.length > 0) {
        throw this.inventoryConflict([
          reservation.event_id,
          ...colliding.map((c) => c.event_id).sort(),
        ]);
      }
      // SCH-03: holds are stamped from the injected Clock, like every other hold writer.
      const stampedAt = this.clock.now();
      for (const unitId of missing) {
        try {
          await trx
            .insertInto('reservation_units')
            .values({
              id: newId(),
              organization_id: organizationId,
              reservation_id: reservation.id,
              event_id: reservation.event_id,
              conflict_unit_id: unitId,
              occupied,
              created_at: stampedAt,
              updated_at: stampedAt,
            })
            .execute();
        } catch (error) {
          // a concurrent reservation took the space: the whole inventory change rolls back
          if (isExclusionViolation(error)) throw this.inventoryConflict([reservation.event_id]);
          throw error;
        }
      }
    }
  }

  private inventoryConflict(eventIds: string[]): Error {
    const conflictingEventIds = [...new Set(eventIds)];
    return errors.resourceConflict(
      'The inventory change would put an existing reservation on space that is already reserved.',
      { conflicts: [], conflictingEventIds },
    );
  }

  /** Every unit mapped to a subdivision below the resource, at any depth. */
  private async descendantUnits(
    trx: Trx,
    organizationId: string,
    resourceId: string,
  ): Promise<string[]> {
    const descendants: string[] = [];
    const seen = new Set<string>([resourceId]);
    let frontier = [resourceId];
    while (frontier.length > 0) {
      const children = await trx
        .selectFrom('resources')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('parent_resource_id', 'in', frontier)
        .execute();
      frontier = children.map((c) => c.id).filter((id) => !seen.has(id));
      for (const id of frontier) seen.add(id);
      descendants.push(...frontier);
    }
    if (descendants.length === 0) return [];
    const units = await trx
      .selectFrom('resource_conflict_units')
      .select('conflict_unit_id')
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('resource_id', 'in', descendants)
      .execute();
    return units.map((u) => u.conflict_unit_id);
  }

  private async unitsOf(trx: Trx, organizationId: string, resourceId: string): Promise<string[]> {
    const rows = await trx
      .selectFrom('resource_conflict_units')
      .select('conflict_unit_id')
      .where('organization_id', '=', organizationId)
      .where('resource_id', '=', resourceId)
      .orderBy('conflict_unit_id')
      .execute();
    return rows.map((r) => r.conflict_unit_id);
  }

  private async setMembers(
    trx: Trx,
    organizationId: string,
    configurationId: string,
    memberResourceIds: string[],
  ): Promise<void> {
    await trx
      .deleteFrom('resource_configuration_members')
      .where('organization_id', '=', organizationId)
      .where('configuration_id', '=', configurationId)
      .execute();
    for (const resourceId of new Set(memberResourceIds)) {
      await trx
        .insertInto('resource_configuration_members')
        .values({
          organization_id: organizationId,
          configuration_id: configurationId,
          resource_id: resourceId,
        })
        .execute();
    }
  }

  private async resourceView(db: Trx | Db, row: ResourceRow): Promise<Resource> {
    const units = await db
      .selectFrom('resource_conflict_units')
      .select('conflict_unit_id')
      .where('organization_id', '=', row.organization_id)
      .where('resource_id', '=', row.id)
      .orderBy('conflict_unit_id')
      .execute();
    return {
      id: row.id,
      facilityId: row.facility_id,
      kind: row.kind,
      name: row.name,
      parentResourceId: row.parent_resource_id,
      dimensions: row.dimensions,
      compatibleFormats: row.compatible_formats,
      defaultSetupMinutes: row.default_setup_minutes,
      defaultCleanupMinutes: row.default_cleanup_minutes,
      requiredEquipment: row.required_equipment,
      staffingConstraints: row.staffing_constraints,
      status: row.status,
      conflictUnitIds: units.map((u) => u.conflict_unit_id),
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private async configurationView(
    db: Trx | Db,
    row: ConfigurationRow,
  ): Promise<ResourceConfiguration> {
    const members = await db
      .selectFrom('resource_configuration_members')
      .select('resource_id')
      .where('organization_id', '=', row.organization_id)
      .where('configuration_id', '=', row.id)
      .orderBy('resource_id')
      .execute();
    return {
      id: row.id,
      facilityId: row.facility_id,
      name: row.name,
      description: row.description,
      active: row.active,
      memberResourceIds: members.map((m) => m.resource_id),
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}

function hoursView(row: {
  id: string;
  facility_id: string;
  resource_id: string | null;
  weekday: number;
  opens_at: string;
  closes_at: string;
}): OperatingHours {
  return {
    id: row.id,
    facilityId: row.facility_id,
    resourceId: row.resource_id,
    weekday: row.weekday,
    opensAt: row.opens_at.slice(0, 5),
    closesAt: row.closes_at.slice(0, 5),
  };
}

/** Unique (organization, facility, name) is a database guarantee; report it as a validation failure. */
async function uniqueName<T>(what: string, insert: Promise<T>): Promise<T> {
  try {
    return await insert;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw errors.validation(`A ${what} with this name or window already exists in the facility.`);
    }
    throw error;
  }
}
