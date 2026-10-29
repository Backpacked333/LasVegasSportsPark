import { Injectable } from '@nestjs/common';
import {
  errors,
  ImportProvenanceSchema,
  PartyCommitmentSchema,
  type Event,
  type PartyCommitment,
  type Principal,
} from '@sportspark/contracts';
import {
  assertImportPrincipal,
  AuditWriter,
  databaseConstraintOf,
  importContentMismatch,
  UnitOfWork,
  type Trx,
} from '../../../kernel';
import type { ProposedEvent } from '../conflicts/conflict-detector';
import type { ImportEventInput } from '../ports';
import { EventWriter, sameResourceSet, type EventRow } from './event-writer';
import { organizationOf } from './organization';

/** `events.source_type` of an imported event; `source_id` is its import batch (SCH-04, §5.3). */
export const IMPORT_SOURCE_TYPE = 'import';

interface ImportedContent {
  facilityId: string;
  kind: Event['kind'];
  title: string;
  format: string | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  setupMinutes: number;
  cleanupMinutes: number;
  resourceIds: string[];
  commitments: PartyCommitment[];
}

const commitmentKey = (commitments: readonly PartyCommitment[]): string =>
  JSON.stringify(
    commitments
      .map((c) => [c.partyType, c.partyId, c.role] as const)
      .sort((a, b) => a.join('|').localeCompare(b.join('|'))),
  );

/**
 * EventSchedulingPort.importEvent (SCH-04, IF-31, IF-40; §5.3 future schedules, §5.4, SPK-AT-024).
 * Only the migration import principal of the batch writes (`assertImportPrincipal`); the event is
 * created if absent with `id = recordId`, as a `draft` with `source_type 'import'` and
 * `source_id = batchId`, inside the caller's unit of work. A draft holds no space, so the import
 * itself runs conflict detection for the event's interval, resources and buffers against the
 * current reservations, closures and conflict units, and refuses with RESOURCE_CONFLICT
 * `IMPORT_SCHEDULE_CONFLICT` writing nothing. The draft is published only through a schedule
 * draft whose `create` change names it (SPK-SCHED-005/006), whose validation and publication
 * re-detect conflicts that arose later. Importing publishes nothing: no reservation, no notice.
 * The batch is the sanctioned writer, so this never calls RECORD_AUTHORITY_PORT (§5.6).
 */
@Injectable()
export class EventImportService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly writer: EventWriter,
  ) {}

  async importEvent(principal: Principal, input: ImportEventInput): Promise<Event> {
    const provenance = ImportProvenanceSchema.safeParse(input.importProvenance);
    if (!provenance.success) {
      throw errors.validation('The import provenance is not valid.', {
        issues: provenance.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const { batchId, externalKey, recordId } = provenance.data;
    assertImportPrincipal(principal, provenance.data);
    const organizationId = organizationOf(principal);
    const scheduledStart = new Date(input.scheduledStart);
    const scheduledEnd = new Date(input.scheduledEnd);
    if (!(scheduledStart.getTime() < scheduledEnd.getTime())) {
      throw errors.validation('scheduledStart must be before scheduledEnd.', { externalKey });
    }
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, input.facilityId);
      const resources = await this.writer.loadResources(
        trx,
        organizationId,
        facility.id,
        input.resourceIds,
      );
      // SPK-SCHED-003: an imported event holds at least its resources' turnover requirement
      const buffers = this.writer.effectiveBuffers(resources, input);
      const content: ImportedContent = {
        facilityId: facility.id,
        kind: input.kind,
        title: input.title,
        format: input.format ?? null,
        scheduledStart,
        scheduledEnd,
        setupMinutes: buffers.setupMinutes,
        cleanupMinutes: buffers.cleanupMinutes,
        resourceIds: resources.map((r) => r.id),
        commitments: (input.commitments ?? []).map((c) => PartyCommitmentSchema.parse(c)),
      };

      const existing = await this.writer.loadEvent(trx, organizationId, recordId);
      if (existing) {
        return this.sameImport(existing, batchId, externalKey, content, {
          setupMinutes: input.setupMinutes,
          cleanupMinutes: input.cleanupMinutes,
        });
      }

      // A draft holds nothing: this check against the current schedule is the import's own.
      const proposal: ProposedEvent = {
        key: recordId,
        eventId: null,
        kind: content.kind,
        format: content.format,
        scheduledStart,
        scheduledEnd,
        setupMinutes: content.setupMinutes,
        cleanupMinutes: content.cleanupMinutes,
        resourceIds: content.resourceIds,
        commitments: content.commitments,
      };
      const blocking = (
        await this.writer.detectConflicts(trx, organizationId, facility, [proposal])
      ).filter((c) => c.severity === 'error');
      if (blocking.length > 0) {
        throw errors.resourceConflict(
          'The imported event conflicts with the current schedule; it is not imported.',
          {
            code: 'IMPORT_SCHEDULE_CONFLICT',
            recordId,
            externalKey,
            conflicts: blocking.map((c) => c.detail),
            conflictingEventIds: [
              ...new Set(blocking.flatMap((c) => c.detail.conflictingEventIds)),
            ].sort(),
          },
        );
      }

      let event: EventRow;
      try {
        // a joined unit: a concurrent import of the same record fails only this insert
        event = await this.uow.run(({ trx: inner }) =>
          this.insertDraft(inner, recordId, batchId, {
            organizationId,
            timezone: facility.timezone,
            content,
          }),
        );
      } catch (error) {
        if (databaseConstraintOf(error)?.code !== '23505') throw error;
        const raced = await this.writer.loadEvent(trx, organizationId, recordId);
        if (!raced) throw error;
        return this.sameImport(raced, batchId, externalKey, content, {
          setupMinutes: input.setupMinutes,
          cleanupMinutes: input.cleanupMinutes,
        });
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.event_imported',
        targetType: 'event',
        targetId: event.id,
        afterRevision: event.revision,
        reason: null,
        correlationId: input.correlationId ?? null,
        details: { batchId, externalKey, status: 'draft' },
      });
      return this.writer.view(event);
    });
  }

  private insertDraft(
    trx: Trx,
    recordId: string,
    batchId: string,
    data: { organizationId: string; timezone: string; content: ImportedContent },
  ): Promise<EventRow> {
    const { content } = data;
    return this.writer.insertEvent(trx, {
      id: recordId,
      organizationId: data.organizationId,
      facilityId: content.facilityId,
      timezone: data.timezone,
      kind: content.kind,
      title: content.title,
      format: content.format,
      scheduledStart: content.scheduledStart,
      scheduledEnd: content.scheduledEnd,
      setupMinutes: content.setupMinutes,
      cleanupMinutes: content.cleanupMinutes,
      status: 'draft',
      resourceIds: content.resourceIds,
      commitments: content.commitments,
      sourceType: IMPORT_SOURCE_TYPE,
      sourceId: batchId,
    });
  }

  /**
   * Same record and content: the existing event with no new effects; otherwise a mismatch (K-13).
   * Buffers are compared with what the legacy record asked for, not only with today's derivation:
   * the stored value is the larger of the request and the resources' turnover floor when it was
   * imported, so a later change of a resource's default buffer does not turn an unchanged record
   * into IMPORT_CONTENT_MISMATCH.
   */
  private sameImport(
    existing: EventRow,
    batchId: string,
    externalKey: string,
    content: ImportedContent,
    requested: { setupMinutes?: number; cleanupMinutes?: number },
  ): Event {
    const bufferMatches = (stored: number, derivedNow: number, asked: number | undefined) =>
      stored === derivedNow || (asked === undefined ? stored >= 0 : stored >= asked);
    const same =
      existing.source_type === IMPORT_SOURCE_TYPE &&
      existing.source_id === batchId &&
      existing.facility_id === content.facilityId &&
      existing.kind === content.kind &&
      existing.title === content.title &&
      (existing.format ?? null) === content.format &&
      new Date(existing.scheduled_start).getTime() === content.scheduledStart.getTime() &&
      new Date(existing.scheduled_end).getTime() === content.scheduledEnd.getTime() &&
      bufferMatches(existing.setup_minutes, content.setupMinutes, requested.setupMinutes) &&
      bufferMatches(existing.cleanup_minutes, content.cleanupMinutes, requested.cleanupMinutes) &&
      sameResourceSet(existing.resource_ids, content.resourceIds) &&
      commitmentKey(this.writer.commitmentsOf(existing)) === commitmentKey(content.commitments);
    if (!same) throw importContentMismatch({ recordId: existing.id, externalKey });
    return this.writer.view(existing);
  }
}
