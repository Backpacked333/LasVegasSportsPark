import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  PartyCommitmentSchema,
  RecurrenceRuleSchema,
  type CreateEventSeriesBody,
  type EditEventSeriesBody,
  type EventDetails,
  type EventSeries,
  type Principal,
  type SeriesEditPreview,
} from '@sportspark/contracts';
import { json, type Db, type EventSeriesTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import type { ProposedEvent } from '../conflicts/conflict-detector';
import { SchedulingActions } from '../scheduling.actions';
import type { EventChangeKind } from '../scheduling.events';
import { localDateOf, localTimeOf, resolveLocal } from '../time/local-time';
import { materializeOccurrences } from '../time/recurrence';
import { EventWriter, type EventRow } from './event-writer';
import { organizationOf } from './events.service';

type SeriesRow = Selectable<EventSeriesTable>;

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
      const resources = await this.writer.loadResources(
        trx,
        organizationId,
        facility.id,
        body.resourceIds,
      );
      const buffers = this.writer.defaultBuffers(resources);
      const policy = this.writer.policyFor(facility);
      const occurrences = materializeOccurrences(body.recurrence, {
        localStartTime: body.localStartTime,
        durationMinutes: body.durationMinutes,
        timezone: facility.timezone,
        policy: {
          nonexistent: body.nonexistentPolicy ?? 'shift_forward',
          ambiguous: body.ambiguousPolicy ?? 'first',
        },
        exceptions: body.exceptions ?? [],
        maxOccurrences: policy.maxSeriesOccurrences,
      });
      if (occurrences.length === 0) {
        throw errors.validation('The recurrence rule produces no occurrences.');
      }
      const commitments = (body.commitments ?? []).map((c) => PartyCommitmentSchema.parse(c));
      const setupMinutes = body.setupMinutes ?? buffers.setupMinutes;
      const cleanupMinutes = body.cleanupMinutes ?? buffers.cleanupMinutes;
      const resourceIds = resources.map((r) => r.id);
      const proposals: ProposedEvent[] = occurrences.map((o) => ({
        key: `occurrence:${o.occurrenceIndex}`,
        eventId: null,
        kind: body.kind,
        format: null,
        scheduledStart: o.start,
        scheduledEnd: o.end,
        setupMinutes,
        cleanupMinutes,
        resourceIds,
        commitments,
      }));
      await this.writer.detectOrThrow(trx, organizationId, facility, proposals);

      const seriesId = newId();
      const series = await trx
        .insertInto('event_series')
        .values({
          id: seriesId,
          organization_id: organizationId,
          facility_id: facility.id,
          kind: body.kind,
          title: body.title,
          timezone: facility.timezone,
          recurrence: json(body.recurrence),
          local_start_time: body.localStartTime,
          duration_minutes: body.durationMinutes,
          setup_minutes: setupMinutes,
          cleanup_minutes: cleanupMinutes,
          nonexistent_policy: body.nonexistentPolicy ?? 'shift_forward',
          ambiguous_policy: body.ambiguousPolicy ?? 'first',
          exceptions: json(body.exceptions ?? []),
          resource_ids: resourceIds,
          commitments: json(commitments),
          source_type: body.sourceType ?? null,
          source_id: body.sourceId ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const eventIds: string[] = [];
      for (const occurrence of occurrences) {
        const event = await this.writer.insertEvent(trx, {
          organizationId,
          facilityId: facility.id,
          timezone: facility.timezone,
          kind: body.kind,
          title: body.title,
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
          sourceType: body.sourceType ?? null,
          sourceId: body.sourceId ?? null,
        });
        await this.writer.reserve(trx, event, facility);
        await this.writer.notifyChanged(trx, {
          organizationId,
          event,
          change: 'created',
          before: null,
          after: await this.writer.details(trx, event),
          correlationId: correlationId ?? null,
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
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: { occurrences: eventIds.length },
      });
      return this.view(series, eventIds);
    });
  }

  async getSeries(principal: Principal, seriesId: string): Promise<EventSeries> {
    const organizationId = organizationOf(principal);
    const series = await this.load(this.db, organizationId, seriesId);
    if (!series) throw errors.notFound('event series', seriesId);
    await this.authorization.require(principal, SchedulingActions.readSchedule, {
      type: 'event_series',
      id: seriesId,
      organizationId,
      facilityId: series.facility_id,
    });
    const events = await this.db
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
      const all = await trx
        .selectFrom('events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('series_id', '=', seriesId)
        .orderBy('occurrence_index')
        .execute();
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
        const proposal = this.writer.proposalOf(event, {
          key: event.id,
          scheduledStart,
          scheduledEnd,
          setupMinutes: body.changes.setupMinutes ?? event.setup_minutes,
          cleanupMinutes: body.changes.cleanupMinutes ?? event.cleanup_minutes,
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
          .executeTakeFirstOrThrow();
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
        if (body.changes.setupMinutes !== undefined)
          seriesUpdate.setup_minutes = body.changes.setupMinutes;
        if (body.changes.cleanupMinutes !== undefined)
          seriesUpdate.cleanup_minutes = body.changes.cleanupMinutes;
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
