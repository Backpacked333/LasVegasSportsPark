import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type DisableFacilityPublicViewInput,
  type EnableFacilityPublicViewInput,
  type FacilityPublicView,
  type Principal,
  type PublicDaySchedule,
  type PublicScheduleEntry,
  type PublicScheduleKind,
} from '@sportspark/contracts';
import { json, type Db, type EventKind, type FacilityPublicViewsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { SchedulingActions } from '../scheduling.actions';
import { PublicScheduleViewChanged } from '../scheduling.events';
import { organizationOf } from '../services/organization';
import { addDays, localDateOf, resolveLocal } from '../time/local-time';
import {
  PUBLIC_CACHE_SECONDS,
  PublicScheduleTitles,
  newPublicCode,
  publicViewNotAvailable,
  resolvePublicOrganization,
} from './public-access';

/**
 * The words a visitor reads for an event no title was vouched for (SPK-SCHED-010). A rental and
 * a party are private bookings: occupied time, "Reserved", never the renter. The wording for
 * private bookings is a proposed default (DEC-100, N1).
 */
const KIND_WORDS: Record<EventKind, { kind: PublicScheduleKind; title: string }> = {
  game: { kind: 'game', title: 'League game' },
  practice: { kind: 'practice', title: 'Practice' },
  session: { kind: 'class', title: 'Class' },
  pickup: { kind: 'pickup', title: 'Pickup session' },
  rental: { kind: 'reserved', title: 'Reserved' },
  party: { kind: 'reserved', title: 'Reserved' },
  maintenance: { kind: 'unavailable', title: 'Not available' },
  block: { kind: 'unavailable', title: 'Not available' },
};
/** Kinds whose time is shown but never titled by anyone: a private booking, a blocked time. */
const NEVER_TITLED: ReadonlySet<EventKind> = new Set(['rental', 'party', 'maintenance', 'block']);

type ViewRow = Selectable<FacilityPublicViewsTable>;

/**
 * A facility's public day schedule and the staff switch that enables it (SPK-SCHED-010, proposed
 * amendment PA-06; capability `public_schedule`, pending DEC-100; ADR-005). The public read is a
 * query of its own into `PublicDaySchedule`, a shape with no person, booker, contact or id.
 */
@Injectable()
export class PublicScheduleService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly titles: PublicScheduleTitles,
  ) {}

  // -------------------------------------------------------------------------------------------
  // The public read (no sign-in)
  // -------------------------------------------------------------------------------------------
  async day(organizationSlug: string, code: string, date?: string): Promise<PublicDaySchedule> {
    const db = executorFor(this.db);
    const organization = await resolvePublicOrganization(db, this.capabilities, organizationSlug);
    const view = await db
      .selectFrom('facility_public_views')
      .select(['facility_id'])
      .where('organization_id', '=', organization.id)
      .where('public_code', '=', code)
      .where('enabled', '=', true)
      .executeTakeFirst();
    if (!view) throw publicViewNotAvailable();
    const facility = await db
      .selectFrom('facilities')
      .select(['id', 'name', 'timezone'])
      .where('organization_id', '=', organization.id)
      .where('id', '=', view.facility_id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!facility) throw publicViewNotAvailable();

    const now = this.clock.now();
    const day = date ?? localDateOf(facility.timezone, now);
    const from = resolveLocal(day, '00:00', facility.timezone)?.instant;
    const to = resolveLocal(addDays(day, 1), '00:00', facility.timezone)?.instant;
    if (!from || !to) throw errors.validation('date is not a day of this facility.', { date: day });

    const resources = await db
      .selectFrom('resources')
      .select(['id', 'name'])
      .where('organization_id', '=', organization.id)
      .where('facility_id', '=', facility.id)
      .where('status', '<>', 'closed')
      .orderBy('name')
      .orderBy('id')
      .execute();
    const nameOf = new Map(resources.map((resource) => [resource.id, resource.name]));
    // Published events only: a draft or a canceled event is not part of the day.
    const events = await db
      .selectFrom('events')
      .select([
        'id',
        'kind',
        'scheduled_start',
        'scheduled_end',
        'resource_ids',
        'source_type',
        'source_id',
      ])
      .where('organization_id', '=', organization.id)
      .where('facility_id', '=', facility.id)
      .where('status', '=', 'published')
      .where('scheduled_start', '<', to)
      .where('scheduled_end', '>', from)
      .orderBy('scheduled_start')
      .orderBy('id')
      .execute();
    const vouched = await this.titles.collect(
      db,
      organization.id,
      events
        .filter((event) => !NEVER_TITLED.has(event.kind))
        .map((event) => ({
          eventId: event.id,
          sourceType: event.source_type,
          sourceId: event.source_id,
        })),
    );
    const entries: PublicScheduleEntry[] = events.map((event) => {
      const words = KIND_WORDS[event.kind];
      const title = NEVER_TITLED.has(event.kind) ? undefined : vouched.get(event.id);
      return {
        startsAt: new Date(event.scheduled_start).toISOString(),
        endsAt: new Date(event.scheduled_end).toISOString(),
        fields: event.resource_ids
          .map((id) => nameOf.get(id))
          .filter((name): name is string => name !== undefined)
          .sort(),
        kind: words.kind,
        title: title?.title ?? words.title,
        score: title?.score ?? null,
      };
    });
    return {
      organizationName: organization.name,
      facilityName: facility.name,
      timezone: facility.timezone,
      date: day,
      fields: resources.map((resource) => resource.name),
      entries,
      computedAt: now.toISOString(),
      cacheSeconds: PUBLIC_CACHE_SECONDS,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Staff: the switch of a facility's public schedule and its link
  // -------------------------------------------------------------------------------------------
  async view(principal: Principal, facilityId: string): Promise<FacilityPublicView> {
    const organizationId = organizationOf(principal);
    await this.loadFacility(this.db, organizationId, facilityId);
    await this.authorization.require(principal, SchedulingActions.readInventory, {
      type: 'facility_public_view',
      organizationId,
      facilityId,
    });
    return this.toView(this.db, organizationId, facilityId);
  }

  async enable(
    principal: Principal,
    facilityId: string,
    input: EnableFacilityPublicViewInput,
    correlationId: string | null,
  ): Promise<FacilityPublicView> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      await this.loadFacility(trx, organizationId, facilityId);
      await this.authorization.require(principal, SchedulingActions.managePublicSchedule, {
        type: 'facility_public_view',
        organizationId,
        facilityId,
      });
      await this.capabilities.require(organizationId, 'public_schedule', trx);
      const current = await this.lockView(trx, organizationId, facilityId);
      let row: { id: string; revision: number; code: string };
      if (!current) {
        if (input.expectedRevision !== undefined) assertExpectedRevision(input.expectedRevision, 0);
        row = { id: newId(), revision: 1, code: newPublicCode() };
        await trx
          .insertInto('facility_public_views')
          .values({
            id: row.id,
            organization_id: organizationId,
            facility_id: facilityId,
            public_code: row.code,
            enabled_at: now,
            enabled_by: json(snapshotActor(principal)),
          })
          .execute();
      } else {
        assertExpectedRevision(input.expectedRevision, current.revision);
        row = {
          id: current.id,
          revision: current.revision + 1,
          code: input.newCode ? newPublicCode() : current.public_code,
        };
        await trx
          .updateTable('facility_public_views')
          .set({
            enabled: true,
            public_code: row.code,
            enabled_at: now,
            enabled_by: json(snapshotActor(principal)),
            disabled_at: null,
            disabled_by: null,
            revision: row.revision,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', current.id)
          .where('revision', '=', current.revision)
          .execute();
      }
      await this.record(trx, principal, organizationId, facilityId, row, correlationId, {
        enabled: true,
        newCode: !current || input.newCode === true,
        reason: input.reason ?? null,
        beforeRevision: current?.revision,
      });
      return this.toView(trx, organizationId, facilityId);
    });
  }

  /** Never gated by the capability: an organization can always take a public view down. */
  async disable(
    principal: Principal,
    facilityId: string,
    input: DisableFacilityPublicViewInput,
    correlationId: string | null,
  ): Promise<FacilityPublicView> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      await this.loadFacility(trx, organizationId, facilityId);
      await this.authorization.require(principal, SchedulingActions.disablePublicSchedule, {
        type: 'facility_public_view',
        organizationId,
        facilityId,
      });
      const current = await this.lockView(trx, organizationId, facilityId);
      if (!current) throw errors.notFound('facility_public_view', facilityId);
      assertExpectedRevision(input.expectedRevision, current.revision);
      if (current.enabled) {
        await trx
          .updateTable('facility_public_views')
          .set({
            enabled: false,
            disabled_at: now,
            disabled_by: json(snapshotActor(principal)),
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', current.id)
          .where('revision', '=', current.revision)
          .execute();
        await this.record(
          trx,
          principal,
          organizationId,
          facilityId,
          { id: current.id, revision: current.revision + 1 },
          correlationId,
          {
            enabled: false,
            newCode: false,
            reason: input.reason ?? null,
            beforeRevision: current.revision,
          },
        );
      }
      return this.toView(trx, organizationId, facilityId);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private async loadFacility(db: Db | Trx, organizationId: string, facilityId: string) {
    const facility = await db
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!facility) throw errors.notFound('facility', facilityId);
  }

  private async lockView(
    trx: Trx,
    organizationId: string,
    facilityId: string,
  ): Promise<ViewRow | null> {
    return (
      (await trx
        .selectFrom('facility_public_views')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('facility_id', '=', facilityId)
        .forUpdate()
        .executeTakeFirst()) ?? null
    );
  }

  private async record(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    facilityId: string,
    row: { id: string; revision: number },
    correlationId: string | null,
    change: {
      enabled: boolean;
      newCode: boolean;
      reason: string | null;
      beforeRevision: number | undefined;
    },
  ): Promise<void> {
    // The code itself is not written to the audit record or the event: it is the key to the view.
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: change.enabled
        ? SchedulingActions.managePublicSchedule.id
        : SchedulingActions.disablePublicSchedule.id,
      targetType: 'facility_public_view',
      targetId: row.id,
      beforeRevision: change.beforeRevision,
      afterRevision: row.revision,
      reason: change.reason,
      correlationId,
      details: { facilityId, enabled: change.enabled, newCode: change.newCode },
    });
    await this.outbox.enqueue(trx, PublicScheduleViewChanged, {
      organizationId,
      aggregateType: 'facility_public_view',
      aggregateId: row.id,
      payload: { facilityId, enabled: change.enabled, revision: row.revision },
      correlationId,
    });
  }

  private async toView(
    db: Db | Trx,
    organizationId: string,
    facilityId: string,
  ): Promise<FacilityPublicView> {
    const organization = await db
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    const row = await db
      .selectFrom('facility_public_views')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .executeTakeFirst();
    return {
      facilityId,
      enabled: row?.enabled ?? false,
      organizationSlug: organization.slug,
      publicCode: row?.public_code ?? null,
      enabledAt: row ? new Date(row.enabled_at).toISOString() : null,
      disabledAt: row?.disabled_at ? new Date(row.disabled_at).toISOString() : null,
      revision: row?.revision ?? 0,
    };
  }
}
