import { Inject, Injectable } from '@nestjs/common';
import {
  AmbiguousTimePolicy,
  DomainError,
  errors,
  EventKind,
  LocalTime,
  newId,
  NonexistentTimePolicy,
  PartyCommitmentSchema,
  RecurrenceRuleSchema,
  z,
  type ConflictDetail,
  type CreateEventSeriesBody,
  type EditEventSeriesBody,
  type EventDetails,
  type EventSeries,
  type PartyCommitment,
  type Principal,
  type RecurrenceRule,
  type SeriesEditPreview,
} from '@sportspark/contracts';
import { json, type Db, type EventSeriesTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
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
import type { ProposedEvent } from '../conflicts/conflict-detector';
import type { CancelEventSeriesInput, CreateEventSeriesInput, EventSeriesCreated } from '../ports';
import { SchedulingActions } from '../scheduling.actions';
import type { EventChangeKind } from '../scheduling.events';
import { localDateOf, localTimeOf, resolveLocal } from '../time/local-time';
import { candidateDates, materializeOccurrences } from '../time/recurrence';
import { EventWriter, sameResourceSet, type EventRow, type FacilityRow } from './event-writer';
import { organizationOf } from './organization';

type SeriesRow = Selectable<EventSeriesTable>;

/** SCH-02 (IF-31): a series through the scheduling port holds at most 52 weekly occurrences. */
export const PORT_SERIES_MAX_OCCURRENCES = 52;

const BufferMinutes = z
  .number()
  .int()
  .min(0)
  .max(24 * 60);

/** EventSchedulingPort.createEventSeries input (IF-31): weekly, `count <= 52` or `until`. */
const PortSeriesInput = z.object({
  kind: EventKind,
  title: z.string().min(1).max(200),
  facilityId: z.uuid(),
  resourceIds: z.array(z.uuid()).min(1).max(20),
  recurrence: RecurrenceRuleSchema.refine((r) => r.frequency === 'weekly', {
    message: 'a series through the scheduling port recurs weekly',
  }).refine((r) => r.count === undefined || r.count <= PORT_SERIES_MAX_OCCURRENCES, {
    message: `count is at most ${PORT_SERIES_MAX_OCCURRENCES}`,
  }),
  localStartTime: LocalTime.refine((v) => v !== '24:00', 'a start time is before 24:00'),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60),
  setupMinutes: BufferMinutes.optional(),
  cleanupMinutes: BufferMinutes.optional(),
  nonexistentPolicy: NonexistentTimePolicy.optional(),
  ambiguousPolicy: AmbiguousTimePolicy.optional(),
  commitments: z.array(PartyCommitmentSchema).max(100).optional(),
  sourceType: z.string().min(1).max(100),
  sourceId: z.uuid(),
});

interface SeriesSpec {
  kind: EventKind;
  title: string;
  resourceIds: string[];
  recurrence: RecurrenceRule;
  localStartTime: string;
  durationMinutes: number;
  setupMinutes?: number;
  cleanupMinutes?: number;
  nonexistentPolicy?: NonexistentTimePolicy;
  ambiguousPolicy?: AmbiguousTimePolicy;
  exceptions: string[];
  commitments: PartyCommitment[];
  sourceType: string | null;
  sourceId: string | null;
}

/**
 * SPK-COND-003, IF-31: RESOURCE_CONFLICT naming each conflicting occurrence by its start, with the
 * conflicting event ids and the detector's details.
 */
function occurrenceConflictError(
  occurrences: Array<{
    occurrenceIndex: number;
    occurrenceStart: string;
    details: ConflictDetail[];
  }>,
): Error {
  const conflicts = occurrences
    .filter((o) => o.details.length > 0)
    .map((o) => ({
      occurrenceIndex: o.occurrenceIndex,
      occurrenceStart: o.occurrenceStart,
      conflictingEventIds: [...new Set(o.details.flatMap((d) => d.conflictingEventIds))].sort(),
      details: o.details,
    }));
  return errors.resourceConflict('One or more occurrences of the series conflict.', {
    conflicts,
    conflictingEventIds: [...new Set(conflicts.flatMap((c) => c.conflictingEventIds))].sort(),
  });
}

/**
 * Recurring series (SPK-SCHED-007/008): the rule is stored as facility-local wall-clock time plus
 * the IANA zone; occurrences are materialized as published events with a stable
 * (series, occurrence index) identity and the DST resolution recorded on each event. Edits apply
 * to one occurrence, this and future occurrences, or the entire series, always with an explicit
 * preview of exactly which events change; occurrences that already ended keep their identity and
 * details.
 */
@Injectable()
export class EventSeriesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly writer: EventWriter,
  ) {}

  async createSeries(
    principal: Principal,
    body: CreateEventSeriesBody,
    correlationId?: string,
  ): Promise<EventSeries> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event_series',
        organizationId,
        facilityId: facility.id,
      });
      const { series, eventIds } = await this.writeSeries(trx, principal, facility, {
        spec: {
          kind: body.kind,
          title: body.title,
          resourceIds: body.resourceIds,
          recurrence: body.recurrence,
          localStartTime: body.localStartTime,
          durationMinutes: body.durationMinutes,
          setupMinutes: body.setupMinutes,
          cleanupMinutes: body.cleanupMinutes,
          nonexistentPolicy: body.nonexistentPolicy,
          ambiguousPolicy: body.ambiguousPolicy,
          exceptions: body.exceptions ?? [],
          commitments: body.commitments ?? [],
          sourceType: body.sourceType ?? null,
          sourceId: body.sourceId ?? null,
        },
        maxOccurrences: this.writer.policyFor(facility).maxSeriesOccurrences,
        conflicts: 'per_event',
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
      });
      return this.view(series, eventIds);
    });
  }

  /**
   * EventSchedulingPort.createEventSeries (SCH-02, IF-31; SPK-COND-003 "reserve all required
   * resources together", SPK-SCHED-007/008). A weekly series for an owning record (a recurring
   * rental or party booking, enrollment's `sourceType 'enrollment.booking'`), joined to the
   * caller's unit of work so the reservations commit or roll back with the booking. Every
   * occurrence is detected first: any conflict answers RESOURCE_CONFLICT `{ conflicts:
   * [{ occurrenceIndex, occurrenceStart, conflictingEventIds, details }] }` and nothing is written;
   * otherwise every occurrence is reserved, the exclusion constraints staying the guarantee (a
   * concurrent winner fails the reservation and the whole joined unit rolls back).
   */
  async createPortSeries(
    principal: Principal,
    input: CreateEventSeriesInput,
  ): Promise<EventSeriesCreated> {
    const organizationId = organizationOf(principal);
    const parsed = PortSeriesInput.safeParse(input);
    if (!parsed.success) {
      throw errors.validation(
        'The series request is not valid.',
        parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      );
    }
    const data = parsed.data;
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, data.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event_series',
        organizationId,
        facilityId: facility.id,
      });
      await this.writer.assertScheduleAuthority(trx, organizationId, facility.id);
      this.writer.assertPortSource(principal, data.kind, data.sourceType);
      const { series, eventIds } = await this.writeSeries(trx, principal, facility, {
        spec: {
          kind: data.kind,
          title: data.title,
          resourceIds: data.resourceIds,
          recurrence: data.recurrence,
          localStartTime: data.localStartTime,
          durationMinutes: data.durationMinutes,
          setupMinutes: data.setupMinutes,
          cleanupMinutes: data.cleanupMinutes,
          nonexistentPolicy: data.nonexistentPolicy,
          ambiguousPolicy: data.ambiguousPolicy,
          exceptions: [],
          commitments: data.commitments ?? [],
          sourceType: data.sourceType,
          sourceId: data.sourceId,
        },
        maxOccurrences: PORT_SERIES_MAX_OCCURRENCES,
        conflicts: 'per_occurrence',
        reason: null,
        correlationId: input.correlationId ?? null,
      });
      return { seriesId: series.id, eventIds };
    });
  }

  /**
   * EventSchedulingPort.cancelEventSeries (SCH-02, IF-31): cancels every occurrence that starts at
   * or after `fromInstant` (default now) and is not already canceled, releasing its reservations,
   * with one `scheduling.event_changed` per published occurrence; the series ends. Occurrences
   * that started earlier keep their identity (SPK-SCHED-007). Joins the caller's unit of work;
   * replayed on an ended series it cancels nothing more.
   */
  async cancelPortSeries(
    principal: Principal,
    seriesId: string,
    input: CancelEventSeriesInput,
  ): Promise<{ canceledEventIds: string[] }> {
    const organizationId = organizationOf(principal);
    if (!input.reason || input.reason.length > 2000) {
      throw errors.validation('A cancellation reason of 1 to 2000 characters is required.');
    }
    const from = input.fromInstant ? new Date(input.fromInstant) : null;
    if (from && Number.isNaN(from.getTime())) {
      throw errors.validation('fromInstant must be an instant.');
    }
    return this.uow.run(async ({ trx }) => {
      const series = await this.load(trx, organizationId, seriesId, true);
      if (!series) throw errors.notFound('event series', seriesId);
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event_series',
        id: seriesId,
        organizationId,
        facilityId: series.facility_id,
      });
      await this.writer.assertScheduleAuthority(trx, organizationId, series.facility_id);
      this.writer.assertPortSource(principal, series.kind, series.source_type);
      const fromInstant = from ?? this.clock.now();
      const occurrences = await trx
        .selectFrom('events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('series_id', '=', seriesId)
        .where('status', '<>', 'canceled')
        .where('scheduled_start', '>=', fromInstant)
        .orderBy('occurrence_index')
        .forUpdate()
        .execute();
      const canceledEventIds: string[] = [];
      for (const event of occurrences) {
        const wasPublished = event.status === 'published';
        const before = await this.writer.details(trx, event);
        const canceled = await this.writer.cancel(trx, event, input.reason);
        if (wasPublished) {
          await this.writer.notifyChanged(trx, {
            organizationId,
            event: canceled,
            change: 'canceled',
            before,
            after: null,
            reason: input.reason,
            correlationId: input.correlationId ?? null,
          });
        }
        canceledEventIds.push(event.id);
      }
      if (canceledEventIds.length === 0 && series.status === 'ended') {
        return { canceledEventIds };
      }
      await trx
        .updateTable('event_series')
        .set({ status: 'ended', revision: series.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', seriesId)
        .where('revision', '=', series.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.series_canceled',
        targetType: 'event_series',
        targetId: seriesId,
        beforeRevision: series.revision,
        afterRevision: series.revision + 1,
        reason: input.reason,
        correlationId: input.correlationId ?? null,
        details: { fromInstant: fromInstant.toISOString(), canceledEventIds },
      });
      return { canceledEventIds };
    });
  }

  /**
   * Materializes a series inside the caller's transaction (HTTP create and the port): buffers
   * (SPK-SCHED-003), occurrences in the facility zone with the required DST resolution
   * (SPK-SCHED-008), conflict detection over every occurrence before anything is written, then
   * the series row, each occurrence's event, its reservations and its `created` notice.
   */
  private async writeSeries(
    trx: Trx,
    principal: Principal,
    facility: FacilityRow,
    options: {
      spec: SeriesSpec;
      maxOccurrences: number;
      /** `per_event`: the HTTP conflict details; `per_occurrence`: grouped by occurrence (IF-31). */
      conflicts: 'per_event' | 'per_occurrence';
      reason: string | null;
      correlationId: string | null;
    },
  ): Promise<{ series: SeriesRow; eventIds: string[] }> {
    const { spec } = options;
    const organizationId = facility.organization_id;
    const resources = await this.writer.loadResources(
      trx,
      organizationId,
      facility.id,
      spec.resourceIds,
    );
    // SPK-SCHED-003: the reserved resources' turnover requirement is the minimum buffer
    const buffers = this.writer.effectiveBuffers(resources, spec);
    if (
      options.conflicts === 'per_occurrence' &&
      candidateDates(spec.recurrence, options.maxOccurrences + 1).length > options.maxOccurrences
    ) {
      throw errors.validation(
        `A series through the scheduling port holds at most ${options.maxOccurrences} occurrences.`,
        { code: 'SERIES_TOO_LONG', maxOccurrences: options.maxOccurrences },
      );
    }
    const occurrences = materializeOccurrences(spec.recurrence, {
      localStartTime: spec.localStartTime,
      durationMinutes: spec.durationMinutes,
      timezone: facility.timezone,
      policy: {
        nonexistent: spec.nonexistentPolicy ?? 'shift_forward',
        ambiguous: spec.ambiguousPolicy ?? 'first',
      },
      exceptions: spec.exceptions,
      maxOccurrences: options.maxOccurrences,
    });
    if (occurrences.length === 0) {
      throw errors.validation('The recurrence rule produces no occurrences.');
    }
    // SPK-SCHED-008 "ambiguous or nonexistent times require resolution": a rule whose local start
    // time falls in a daylight-saving gap or overlap on some date is refused until the scheduler
    // chooses how to resolve it; the policy defaults are never applied silently.
    const unresolvedGap = occurrences
      .filter((o) => o.dstResolution === 'shifted_forward' && spec.nonexistentPolicy === undefined)
      .map((o) => o.localDate);
    const unresolvedOverlap = occurrences
      .filter((o) => o.dstResolution === 'first' && spec.ambiguousPolicy === undefined)
      .map((o) => o.localDate);
    if (unresolvedGap.length > 0 || unresolvedOverlap.length > 0) {
      throw errors.validation(
        'The local start time does not exist or occurs twice on some dates; choose how to resolve them.',
        {
          code: 'dst_resolution_required',
          nonexistentLocalDates: unresolvedGap,
          ambiguousLocalDates: unresolvedOverlap,
          options: {
            nonexistentPolicy: unresolvedGap.length > 0 ? ['shift_forward', 'skip'] : [],
            ambiguousPolicy: unresolvedOverlap.length > 0 ? ['first', 'second'] : [],
          },
        },
      );
    }
    const commitments = spec.commitments.map((c) => PartyCommitmentSchema.parse(c));
    const { setupMinutes, cleanupMinutes } = buffers;
    const resourceIds = resources.map((r) => r.id);
    const proposals: ProposedEvent[] = occurrences.map((o) => ({
      key: `occurrence:${o.occurrenceIndex}`,
      eventId: null,
      kind: spec.kind,
      format: null,
      scheduledStart: o.start,
      scheduledEnd: o.end,
      setupMinutes,
      cleanupMinutes,
      resourceIds,
      commitments,
    }));
    if (options.conflicts === 'per_event') {
      await this.writer.detectOrThrow(trx, organizationId, facility, proposals);
    } else {
      // SPK-COND-003: one detection over every occurrence; any conflict refuses the whole series
      const blocking = (
        await this.writer.detectConflicts(trx, organizationId, facility, proposals)
      ).filter((c) => c.severity === 'error');
      if (blocking.length > 0) {
        throw occurrenceConflictError(
          occurrences.map((o) => ({
            occurrenceIndex: o.occurrenceIndex,
            occurrenceStart: o.start.toISOString(),
            details: blocking
              .filter((c) => c.key === `occurrence:${o.occurrenceIndex}`)
              .map((c) => c.detail),
          })),
        );
      }
      // the same lock order as publication and series edits (no deadlock between them)
      await this.writer.lockHolds(trx, organizationId, facility, [{ resourceIds, commitments }]);
    }

    const seriesId = newId();
    const now = this.clock.now();
    const series = await trx
      .insertInto('event_series')
      .values({
        id: seriesId,
        organization_id: organizationId,
        facility_id: facility.id,
        kind: spec.kind,
        title: spec.title,
        timezone: facility.timezone,
        recurrence: json(spec.recurrence),
        local_start_time: spec.localStartTime,
        duration_minutes: spec.durationMinutes,
        setup_minutes: setupMinutes,
        cleanup_minutes: cleanupMinutes,
        nonexistent_policy: spec.nonexistentPolicy ?? 'shift_forward',
        ambiguous_policy: spec.ambiguousPolicy ?? 'first',
        exceptions: json(spec.exceptions),
        resource_ids: resourceIds,
        commitments: json(commitments),
        source_type: spec.sourceType,
        source_id: spec.sourceId,
        // SCH-03: the injected Clock, not the database default
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const eventIds: string[] = [];
    for (const occurrence of occurrences) {
      const event = await this.writer.insertEvent(trx, {
        organizationId,
        facilityId: facility.id,
        timezone: facility.timezone,
        kind: spec.kind,
        title: spec.title,
        format: null,
        seriesId,
        occurrenceIndex: occurrence.occurrenceIndex,
        scheduledStart: occurrence.start,
        scheduledEnd: occurrence.end,
        setupMinutes,
        cleanupMinutes,
        dstResolution: occurrence.dstResolution,
        status: 'published',
        resourceIds,
        commitments,
        sourceType: spec.sourceType,
        sourceId: spec.sourceId,
      });
      try {
        await this.writer.reserve(trx, event, facility);
      } catch (error) {
        // a concurrent command took the space after detection: the whole series is refused
        if (options.conflicts === 'per_occurrence' && DomainError.is(error)) {
          if (error.code === 'RESOURCE_CONFLICT') {
            const details = (error.details ?? {}) as { conflicts?: ConflictDetail[] };
            throw occurrenceConflictError([
              {
                occurrenceIndex: occurrence.occurrenceIndex,
                occurrenceStart: occurrence.start.toISOString(),
                details: details.conflicts ?? [],
              },
            ]);
          }
        }
        throw error;
      }
      await this.writer.notifyChanged(trx, {
        organizationId,
        event,
        change: 'created',
        before: null,
        after: await this.writer.details(trx, event),
        reason: options.reason,
        correlationId: options.correlationId,
      });
      eventIds.push(event.id);
    }
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: 'scheduling.series_created',
      targetType: 'event_series',
      targetId: seriesId,
      afterRevision: series.revision,
      reason: options.reason,
      correlationId: options.correlationId,
      details: {
        occurrences: eventIds.length,
        sourceType: spec.sourceType,
        sourceId: spec.sourceId,
      },
    });
    return { series, eventIds };
  }

  async getSeries(principal: Principal, seriesId: string): Promise<EventSeries> {
    const organizationId = organizationOf(principal);
    const series = await this.load(executorFor(this.db), organizationId, seriesId);
    if (!series) throw errors.notFound('event series', seriesId);
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'event_series',
      id: seriesId,
      organizationId,
      facilityId: series.facility_id,
    });
    const events = await executorFor(this.db)
      .selectFrom('events')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('series_id', '=', seriesId)
      .orderBy('occurrence_index')
      .execute();
    return this.view(
      series,
      events.map((e) => e.id),
    );
  }

  /** Preview or commit an edit to one occurrence, this and future occurrences, or the entire series. */
  async editSeries(
    principal: Principal,
    seriesId: string,
    body: EditEventSeriesBody,
    correlationId?: string,
  ): Promise<SeriesEditPreview> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const series = await this.load(trx, organizationId, seriesId, !body.preview);
      if (!series) throw errors.notFound('event series', seriesId);
      const facility = await this.writer.loadFacility(trx, organizationId, series.facility_id);
      await this.authorization.require(principal, SchedulingActions.manageEvents, {
        type: 'event_series',
        id: seriesId,
        organizationId,
        facilityId: facility.id,
      });
      assertExpectedRevision(body.expectedRevision, series.revision);
      const now = this.clock.now();
      // A committing edit locks its occurrences before conflict detection takes the arrangement
      // locks, the same order as a direct move (event row first), so the two cannot deadlock.
      let allQuery = trx
        .selectFrom('events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('series_id', '=', seriesId)
        .orderBy('occurrence_index');
      if (!body.preview) allQuery = allQuery.forUpdate();
      const all = await allQuery.execute();
      const inScope = (e: EventRow): boolean => {
        if (e.status === 'canceled') return false;
        if (new Date(e.scheduled_end).getTime() <= now.getTime()) return false; // played/attended history keeps its identity
        const index = e.occurrence_index ?? -1;
        if (body.scope === 'one') return index === body.occurrenceIndex;
        if (body.scope === 'this_and_future') return index >= (body.occurrenceIndex ?? 0);
        return true;
      };
      const targets = all.filter(inScope);
      if (body.scope === 'one') {
        const target = all.find((e) => e.occurrence_index === body.occurrenceIndex);
        if (!target) throw errors.notFound('occurrence', String(body.occurrenceIndex));
        if (target.status === 'canceled')
          throw errors.invalidTransition('Event', 'canceled', 'edit');
        if (targets.length === 0) {
          throw errors.validation('The occurrence already ended; past events keep their identity.');
        }
      }
      const resources =
        body.changes.resourceIds === undefined
          ? null
          : await this.writer.loadResources(
              trx,
              organizationId,
              facility.id,
              body.changes.resourceIds,
            );
      const policy = {
        nonexistent: series.nonexistent_policy,
        ambiguous: series.ambiguous_policy,
      };
      // SPK-SCHED-003: buffers follow the resources actually reserved; current buffers carry over
      // only while an occurrence stays on the same resources, never below their requirement.
      const resourcesById = new Map<string, Awaited<ReturnType<EventWriter['loadResources']>>>();
      const resourcesOf = async (ids: string[]) => {
        const cacheKey = [...new Set(ids)].sort().join(',');
        let rows = resourcesById.get(cacheKey);
        if (!rows) {
          rows = await this.writer.loadResources(trx, organizationId, facility.id, ids);
          resourcesById.set(cacheKey, rows);
        }
        return rows;
      };
      const buffersFor = async (
        currentResourceIds: string[],
        current: { setup_minutes: number; cleanup_minutes: number },
      ) => {
        const reserved = resources ?? (await resourcesOf(currentResourceIds));
        const same = sameResourceSet(
          reserved.map((r) => r.id),
          currentResourceIds,
        );
        return this.writer.effectiveBuffers(reserved, {
          setupMinutes: body.changes.setupMinutes ?? (same ? current.setup_minutes : undefined),
          cleanupMinutes:
            body.changes.cleanupMinutes ?? (same ? current.cleanup_minutes : undefined),
        });
      };

      const plans: Array<{
        event: EventRow;
        before: EventDetails;
        after: EventDetails | null;
        proposal: ProposedEvent | null;
        changeKind: EventChangeKind;
        dstResolution: EventRow['dst_resolution'];
      }> = [];
      for (const event of targets) {
        const before = await this.writer.details(trx, event);
        if (body.changes.cancel) {
          plans.push({
            event,
            before,
            after: null,
            proposal: null,
            changeKind: 'canceled',
            dstResolution: event.dst_resolution,
          });
          continue;
        }
        const localDate = localDateOf(facility.timezone, new Date(event.scheduled_start));
        const localTime =
          body.changes.localStartTime ??
          localTimeOf(facility.timezone, new Date(event.scheduled_start));
        const currentDuration = Math.round(
          (new Date(event.scheduled_end).getTime() - new Date(event.scheduled_start).getTime()) /
            60_000,
        );
        const duration = body.changes.durationMinutes ?? currentDuration;
        const resolved = resolveLocal(localDate, localTime, facility.timezone, policy) ?? {
          instant: new Date(event.scheduled_start),
          resolution: event.dst_resolution,
        };
        const scheduledStart = resolved.instant;
        const scheduledEnd = new Date(scheduledStart.getTime() + duration * 60_000);
        const resourceIds = resources ? resources.map((r) => r.id) : event.resource_ids;
        const buffers = await buffersFor(event.resource_ids, event);
        const proposal = this.writer.proposalOf(event, {
          key: event.id,
          scheduledStart,
          scheduledEnd,
          setupMinutes: buffers.setupMinutes,
          cleanupMinutes: buffers.cleanupMinutes,
          resourceIds,
        });
        const timeChanged =
          scheduledStart.getTime() !== new Date(event.scheduled_start).getTime() ||
          scheduledEnd.getTime() !== new Date(event.scheduled_end).getTime();
        const resourcesChanged = resourceIds.join(',') !== event.resource_ids.join(',');
        const changeKind: EventChangeKind = timeChanged
          ? 'moved'
          : resourcesChanged
            ? 'resource_changed'
            : 'updated';
        const after: EventDetails = {
          ...before,
          title: body.changes.title ?? event.title,
          scheduledStart: scheduledStart.toISOString(),
          scheduledEnd: scheduledEnd.toISOString(),
          resources: resources
            ? resources.map((r) => ({ id: r.id, name: r.name }))
            : before.resources,
        };
        plans.push({
          event,
          before,
          after,
          proposal,
          changeKind,
          dstResolution: resolved.resolution,
        });
      }

      const preview: SeriesEditPreview = {
        seriesId,
        scope: body.scope,
        committed: false,
        affected: plans.map((p) => ({
          eventId: p.event.id,
          occurrenceIndex: p.event.occurrence_index ?? 0,
          before: p.before,
          after: p.after,
          dstResolution: p.dstResolution,
        })),
        unchangedEventIds: all.filter((e) => !targets.includes(e)).map((e) => e.id),
      };
      if (body.preview) return preview;

      const proposals = plans.map((p) => p.proposal).filter((p): p is ProposedEvent => p !== null);
      await this.writer.detectOrThrow(
        trx,
        organizationId,
        facility,
        proposals,
        targets.map((t) => t.id),
      );
      await this.writer.lockHolds(trx, organizationId, facility, proposals);
      for (const plan of plans) await this.writer.release(trx, organizationId, plan.event.id);
      for (const plan of plans) {
        const event = plan.event;
        if (!plan.proposal || !plan.after) {
          const canceled = await this.writer.cancel(
            trx,
            event,
            body.reason ?? 'Canceled by series edit',
          );
          await this.writer.notifyChanged(trx, {
            organizationId,
            event: canceled,
            change: 'canceled',
            before: plan.before,
            after: null,
            reason: body.reason ?? null,
            correlationId: correlationId ?? null,
          });
          continue;
        }
        const updated = await trx
          .updateTable('events')
          .set({
            title: plan.after.title,
            scheduled_start: plan.proposal.scheduledStart,
            scheduled_end: plan.proposal.scheduledEnd,
            setup_minutes: plan.proposal.setupMinutes,
            cleanup_minutes: plan.proposal.cleanupMinutes,
            resource_ids: plan.proposal.resourceIds,
            dst_resolution: plan.dstResolution,
            revision: event.revision + 1,
            published_revision: event.status === 'published' ? event.revision + 1 : null,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', event.id)
          .where('revision', '=', event.revision)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw await this.writer.staleEvent(trx, event);
        if (updated.status === 'published') {
          await this.writer.reserve(trx, updated, facility);
          await this.writer.notifyChanged(trx, {
            organizationId,
            event: updated,
            change: plan.changeKind,
            before: plan.before,
            after: await this.writer.details(trx, updated),
            reason: body.reason ?? null,
            correlationId: correlationId ?? null,
          });
        }
      }
      const seriesUpdate: Partial<{
        title: string;
        local_start_time: string;
        duration_minutes: number;
        setup_minutes: number;
        cleanup_minutes: number;
        resource_ids: string[];
        status: 'active' | 'ended';
      }> = {};
      if (body.scope === 'entire_series') {
        if (body.changes.title) seriesUpdate.title = body.changes.title;
        if (body.changes.localStartTime)
          seriesUpdate.local_start_time = body.changes.localStartTime;
        if (body.changes.durationMinutes)
          seriesUpdate.duration_minutes = body.changes.durationMinutes;
        if (
          resources ||
          body.changes.setupMinutes !== undefined ||
          body.changes.cleanupMinutes !== undefined
        ) {
          const buffers = await buffersFor(series.resource_ids, series);
          seriesUpdate.setup_minutes = buffers.setupMinutes;
          seriesUpdate.cleanup_minutes = buffers.cleanupMinutes;
        }
        if (resources) seriesUpdate.resource_ids = resources.map((r) => r.id);
        if (body.changes.cancel) seriesUpdate.status = 'ended';
      }
      await trx
        .updateTable('event_series')
        .set({ ...seriesUpdate, revision: series.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', seriesId)
        .where('revision', '=', series.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.series_edited',
        targetType: 'event_series',
        targetId: seriesId,
        beforeRevision: series.revision,
        afterRevision: series.revision + 1,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: {
          scope: body.scope,
          occurrenceIndex: body.occurrenceIndex ?? null,
          affected: plans.length,
        },
      });
      return { ...preview, committed: true };
    });
  }

  private async load(
    db: Trx | Db,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<SeriesRow | undefined> {
    let q = db
      .selectFrom('event_series')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private view(row: SeriesRow, eventIds: string[]): EventSeries {
    return {
      id: row.id,
      facilityId: row.facility_id,
      kind: row.kind,
      title: row.title,
      timezone: row.timezone,
      recurrence: RecurrenceRuleSchema.parse(row.recurrence),
      localStartTime: row.local_start_time.slice(0, 5),
      durationMinutes: row.duration_minutes,
      setupMinutes: row.setup_minutes,
      cleanupMinutes: row.cleanup_minutes,
      nonexistentPolicy: row.nonexistent_policy,
      ambiguousPolicy: row.ambiguous_policy,
      exceptions: row.exceptions,
      resourceIds: row.resource_ids,
      commitments: (row.commitments as unknown[]).map((c) => PartyCommitmentSchema.parse(c)),
      sourceType: row.source_type,
      sourceId: row.source_id,
      status: row.status,
      revision: row.revision,
      eventIds,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}
