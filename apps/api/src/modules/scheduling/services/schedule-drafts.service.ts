import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  PartyCommitmentSchema,
  ProposedEventFieldsSchema,
  type AutosaveScheduleDraftBody,
  type CommandMeta,
  type CreateScheduleDraftBody,
  type DraftChange,
  type DraftChangeInput,
  type EventDetails,
  type Principal,
  type ProposedEventFields,
  type Publication,
  type ScheduleDraft,
  type ScheduleDraftStatus,
  type ValidationIssue,
  type ValidationResult,
} from '@sportspark/contracts';
import {
  json,
  type Db,
  type DraftChangesTable,
  type PublicationsTable,
  type ScheduleDraftsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  OperationsService,
  Outbox,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import { ConflictDetector, type ProposedEvent } from '../conflicts/conflict-detector';
import {
  FIXTURE_OBLIGATION_PORT,
  type FixtureObligation,
  type FixtureObligationPort,
} from '../ports';
import { SchedulingActions } from '../scheduling.actions';
import { SchedulePublished, type EventChangeKind } from '../scheduling.events';
import { EventMachine, ScheduleDraftMachine } from '../scheduling.state-machines';
import { EventWriter, type EventRow, type FacilityRow } from './event-writer';
import { organizationOf } from './events.service';

type DraftRow = Selectable<ScheduleDraftsTable>;
type ChangeRow = Selectable<DraftChangesTable>;
type PublicationRow = Selectable<PublicationsTable>;

interface PlannedChange {
  change: ChangeRow;
  target: EventRow | null;
  /** The event as it will be after the change (null for cancels). */
  fields: ResolvedFields | null;
  proposal: ProposedEvent | null;
}

interface ResolvedFields {
  kind: EventRow['kind'];
  title: string;
  format: string | null;
  scheduledStart: Date;
  scheduledEnd: Date;
  setupMinutes: number;
  cleanupMinutes: number;
  resourceIds: string[];
  commitments: ReturnType<typeof PartyCommitmentSchema.parse>[];
  sourceType: string | null;
  sourceId: string | null;
}

/**
 * Schedule drafts (SPK-SCHED-005) and publication (SPK-SCHED-006). A draft keeps the base
 * revision of every event it touches, its proposed changes, validation results, author, last
 * save and publication status. Publication runs the seven steps inside one transaction, so a
 * stale base revision or any conflict fails the whole publication group and nothing is partially
 * published; the outcome is readable as an operation.
 */
@Injectable()
export class ScheduleDraftsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FIXTURE_OBLIGATION_PORT) private readonly obligations: FixtureObligationPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly writer: EventWriter,
    private readonly detector: ConflictDetector,
  ) {}

  async create(
    principal: Principal,
    body: CreateScheduleDraftBody,
    correlationId?: string,
  ): Promise<ScheduleDraft> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.writer.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, SchedulingActions.manageDrafts, {
        type: 'schedule_draft',
        organizationId,
        facilityId: facility.id,
      });
      const id = newId();
      const now = this.clock.now();
      await trx
        .insertInto('schedule_drafts')
        .values({
          id,
          organization_id: organizationId,
          facility_id: facility.id,
          name: body.name,
          base_revision: json({ capturedAt: now.toISOString(), eventRevisions: {} }),
          author: json(this.writer.snapshotActor(principal)),
          last_saved_at: now,
          validation_results: null,
          validated_at: null,
          published_at: null,
          publication_group_id: null,
        })
        .execute();
      const eventRevisions = await this.replaceChanges(
        trx,
        organizationId,
        facility.id,
        id,
        body.changes ?? [],
      );
      await trx
        .updateTable('schedule_drafts')
        .set({ base_revision: json({ capturedAt: now.toISOString(), eventRevisions }) })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.draft_created',
        targetType: 'schedule_draft',
        targetId: id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
      });
      return this.view(trx, organizationId, id);
    });
  }

  /** Autosave replaces the change list; the draft revision guards against concurrent editors. */
  async autosave(
    principal: Principal,
    draftId: string,
    body: AutosaveScheduleDraftBody,
    correlationId?: string,
  ): Promise<ScheduleDraft> {
    const organizationId = organizationOf(principal);
    if (body.expectedRevision === undefined) {
      throw errors.validation('expectedRevision is required to autosave a draft.');
    }
    return this.uow.run(async ({ trx }) => {
      const draft = await this.load(trx, organizationId, draftId, true);
      if (!draft) throw errors.notFound('schedule draft', draftId);
      await this.authorization.require(principal, SchedulingActions.manageDrafts, {
        type: 'schedule_draft',
        id: draftId,
        organizationId,
        facilityId: draft.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, draft.revision);
      const next = ScheduleDraftMachine.next(draft.status, 'edit');
      await trx
        .deleteFrom('draft_changes')
        .where('organization_id', '=', organizationId)
        .where('draft_id', '=', draftId)
        .execute();
      const eventRevisions = await this.replaceChanges(
        trx,
        organizationId,
        draft.facility_id,
        draftId,
        body.changes,
      );
      const now = this.clock.now();
      await trx
        .updateTable('schedule_drafts')
        .set({
          name: body.name,
          status: next,
          base_revision: json({ capturedAt: draft.base_revision.capturedAt, eventRevisions }),
          last_saved_at: now,
          validation_results: null,
          validated_at: null,
          revision: draft.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', draftId)
        .where('revision', '=', draft.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.draft_saved',
        targetType: 'schedule_draft',
        targetId: draftId,
        beforeRevision: draft.revision,
        afterRevision: draft.revision + 1,
        correlationId: correlationId ?? null,
        details: { changes: body.changes.length },
      });
      return this.view(trx, organizationId, draftId);
    });
  }

  async validate(
    principal: Principal,
    draftId: string,
    meta: CommandMeta,
    correlationId?: string,
  ): Promise<ScheduleDraft> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const draft = await this.load(trx, organizationId, draftId, true);
      if (!draft) throw errors.notFound('schedule draft', draftId);
      await this.authorization.require(principal, SchedulingActions.manageDrafts, {
        type: 'schedule_draft',
        id: draftId,
        organizationId,
        facilityId: draft.facility_id,
      });
      assertExpectedRevision(meta.expectedRevision, draft.revision);
      const facility = await this.writer.loadFacility(trx, organizationId, draft.facility_id);
      const { result } = await this.plan(trx, organizationId, facility, draft);
      const next = ScheduleDraftMachine.next(draft.status, result.ok ? 'validate' : 'edit');
      await trx
        .updateTable('schedule_drafts')
        .set({
          status: next,
          validation_results: json(result),
          validated_at: new Date(result.validatedAt),
          revision: draft.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', draftId)
        .where('revision', '=', draft.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.draft_validated',
        targetType: 'schedule_draft',
        targetId: draftId,
        beforeRevision: draft.revision,
        afterRevision: draft.revision + 1,
        correlationId: correlationId ?? null,
        details: { ok: result.ok, issues: result.issues.length },
      });
      return this.view(trx, organizationId, draftId);
    });
  }

  /**
   * SPK-SCHED-006 inside one transaction: 1 recheck authorization, 2 revalidate against current
   * records (base revisions), 3 recheck physical conflicts, 4 verify fixture obligations,
   * 5 commit the approved revision, 6 record durable follow-up events, 7 bump published revisions
   * (customer and staff views read the published revision). Any failure rolls everything back.
   */
  async publish(
    principal: Principal,
    draftId: string,
    meta: CommandMeta,
    correlationId?: string,
  ): Promise<Publication> {
    const organizationId = organizationOf(principal);
    const operationId = await this.uow.run(async ({ trx }) => {
      const draft = await this.load(trx, organizationId, draftId);
      if (!draft) throw errors.notFound('schedule draft', draftId);
      await this.authorization.require(principal, SchedulingActions.publishSchedule, {
        type: 'schedule_draft',
        id: draftId,
        organizationId,
        facilityId: draft.facility_id,
      });
      assertExpectedRevision(meta.expectedRevision, draft.revision);
      ScheduleDraftMachine.next(draft.status, 'publish');
      return this.operations.create(trx, {
        organizationId,
        kind: 'scheduling.publish_schedule',
        requestedBy: principal,
        correlationId: correlationId ?? null,
        input: { draftId },
        status: 'running',
      });
    });

    try {
      return await this.uow.run(async ({ trx }) => {
        // 1. recheck authorization against the locked draft
        const draft = await this.load(trx, organizationId, draftId, true);
        if (!draft) throw errors.notFound('schedule draft', draftId);
        await this.authorization.require(principal, SchedulingActions.publishSchedule, {
          type: 'schedule_draft',
          id: draftId,
          organizationId,
          facilityId: draft.facility_id,
        });
        assertExpectedRevision(meta.expectedRevision, draft.revision);
        const publishing = ScheduleDraftMachine.next(draft.status, 'publish');
        await trx
          .updateTable('schedule_drafts')
          .set({ status: publishing })
          .where('organization_id', '=', organizationId)
          .where('id', '=', draftId)
          .execute();
        const facility = await this.writer.loadFacility(trx, organizationId, draft.facility_id);

        // 2 + 3. revalidate current records and recheck physical conflicts
        const { plans, result, stale } = await this.plan(
          trx,
          organizationId,
          facility,
          draft,
          true,
        );
        if (!result.ok) {
          if (stale) throw errors.staleRevision(stale.expected, stale.actual);
          throw errors.resourceConflict('The draft conflicts with current records.', {
            issues: result.issues.filter((i) => i.severity === 'error'),
            conflictingEventIds: [
              ...new Set(result.issues.flatMap((i) => i.detail?.conflictingEventIds ?? [])),
            ],
          });
        }

        // 4. fixture obligations (competition module); blocking ones fail the group
        const obligations = await this.obligations.verify({
          organizationId,
          facilityId: facility.id,
          draftId,
          changes: plans.map((p) => this.changeView(p.change)),
        });
        const blocking = obligations.filter((o) => o.blocking);
        if (blocking.length > 0) {
          throw errors.validation('Fixture obligations are not satisfied.', {
            obligations: blocking,
          });
        }

        // 5. commit: release every targeted hold first so moves within the group never collide with their own old rows
        const publicationId = newId();
        for (const plan of plans) {
          if (plan.target) await this.writer.release(trx, organizationId, plan.target.id);
        }
        const committed: Array<{
          sequence: number;
          kind: ChangeRow['kind'];
          event: EventRow;
          change: EventChangeKind;
          before: EventDetails | null;
          after: EventDetails | null;
        }> = [];
        for (const plan of plans) {
          committed.push(await this.applyChange(trx, organizationId, facility, plan));
        }

        // 6. durable follow-up: one notice per changed event, carrying old and new details (SPK-COMMS-005)
        const noticeIds: string[] = [];
        for (const c of committed) {
          const notice = await this.writer.notifyChanged(trx, {
            organizationId,
            event: c.event,
            change: c.change,
            before: c.before,
            after: c.after,
            publicationId,
            correlationId: correlationId ?? null,
            operationId,
          });
          noticeIds.push(notice.id);
        }
        const remaining = obligations.filter((o) => !o.blocking).map(obligationView);
        const summary = {
          changes: committed.map((c) => ({
            sequence: c.sequence,
            kind: c.kind,
            eventId: c.event.id,
          })),
          remainingObligations: remaining,
        };
        const eventIds = committed.map((c) => c.event.id);
        const now = this.clock.now();
        await trx
          .insertInto('publications')
          .values({
            id: publicationId,
            organization_id: organizationId,
            facility_id: facility.id,
            draft_id: draftId,
            actor: json(this.writer.snapshotActor(principal)),
            committed_at: now,
            event_ids: eventIds,
            notice_event_ids: noticeIds,
            summary: json(summary),
            operation_id: operationId,
          })
          .execute();
        const published = await this.outbox.enqueue(trx, SchedulePublished, {
          organizationId,
          aggregateType: 'schedule_draft',
          aggregateId: draftId,
          correlationId: correlationId ?? null,
          operationId,
          payload: {
            publicationId,
            draftId,
            facilityId: facility.id,
            eventIds,
            changes: summary.changes,
            remainingObligations: remaining,
          },
        });

        // 7. the approved revision is now the published one
        await trx
          .updateTable('schedule_drafts')
          .set({
            status: ScheduleDraftMachine.next(publishing, 'commit'),
            validation_results: json(result),
            validated_at: new Date(result.validatedAt),
            published_at: now,
            publication_group_id: publicationId,
            revision: draft.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', draftId)
          .where('revision', '=', draft.revision)
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'scheduling.schedule_published',
          targetType: 'schedule_draft',
          targetId: draftId,
          beforeRevision: draft.revision,
          afterRevision: draft.revision + 1,
          reason: meta.reason ?? null,
          correlationId: correlationId ?? null,
          operationId,
          details: {
            publicationId,
            eventIds,
            notices: noticeIds.length + 1,
            published: published.id,
          },
        });
        await this.operations.transition(trx, operationId, 'succeeded', {
          result: { publicationId, eventIds },
        });
        const row = await trx
          .selectFrom('publications')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', publicationId)
          .executeTakeFirstOrThrow();
        return publicationView(row);
      });
    } catch (error) {
      if (DomainError.is(error)) {
        await this.recordFailure(
          principal,
          organizationId,
          draftId,
          operationId,
          error,
          correlationId,
        );
      } else {
        await this.uow.run((ctx) =>
          this.operations.transition(ctx.trx, operationId, 'failed', {
            error: { code: 'INTERNAL_ERROR', message: 'Publication failed unexpectedly.' },
          }),
        );
      }
      throw error;
    }
  }

  async discard(
    principal: Principal,
    draftId: string,
    meta: CommandMeta,
    correlationId?: string,
  ): Promise<ScheduleDraft> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const draft = await this.load(trx, organizationId, draftId, true);
      if (!draft) throw errors.notFound('schedule draft', draftId);
      await this.authorization.require(principal, SchedulingActions.manageDrafts, {
        type: 'schedule_draft',
        id: draftId,
        organizationId,
        facilityId: draft.facility_id,
      });
      assertExpectedRevision(meta.expectedRevision, draft.revision);
      const next = ScheduleDraftMachine.next(draft.status, 'discard');
      await trx
        .updateTable('schedule_drafts')
        .set({ status: next, revision: draft.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', draftId)
        .where('revision', '=', draft.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'scheduling.draft_discarded',
        targetType: 'schedule_draft',
        targetId: draftId,
        beforeRevision: draft.revision,
        afterRevision: draft.revision + 1,
        reason: meta.reason ?? null,
        correlationId: correlationId ?? null,
      });
      return this.view(trx, organizationId, draftId);
    });
  }

  async get(principal: Principal, draftId: string): Promise<ScheduleDraft> {
    const organizationId = organizationOf(principal);
    const draft = await this.load(this.db, organizationId, draftId);
    if (!draft) throw errors.notFound('schedule draft', draftId);
    await this.authorization.require(principal, SchedulingActions.manageDrafts, {
      type: 'schedule_draft',
      id: draftId,
      organizationId,
      facilityId: draft.facility_id,
    });
    return this.view(this.db, organizationId, draftId);
  }

  async list(
    principal: Principal,
    facilityId: string,
    status?: ScheduleDraftStatus,
  ): Promise<ScheduleDraft[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SchedulingActions.manageDrafts, {
      type: 'schedule_draft',
      organizationId,
      facilityId,
    });
    let q = this.db
      .selectFrom('schedule_drafts')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .orderBy('created_at', 'desc');
    if (status) q = q.where('status', '=', status);
    const out: ScheduleDraft[] = [];
    for (const row of await q.execute()) out.push(await this.view(this.db, organizationId, row.id));
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------

  private async recordFailure(
    principal: Principal,
    organizationId: string,
    draftId: string,
    operationId: string,
    error: DomainError,
    correlationId?: string,
  ): Promise<void> {
    await this.uow.run(async ({ trx }) => {
      const draft = await this.load(trx, organizationId, draftId, true);
      if (draft && ScheduleDraftMachine.can(draft.status, 'fail')) {
        const result: ValidationResult = {
          ok: false,
          validatedAt: this.clock.now().toISOString(),
          issues: [
            { severity: 'error', code: error.code, message: error.message },
            ...(isIssueDetails(error.details) ? error.details.issues : []),
          ],
        };
        await trx
          .updateTable('schedule_drafts')
          .set({
            status: ScheduleDraftMachine.next(draft.status, 'fail'),
            validation_results: json(result),
            validated_at: new Date(result.validatedAt),
            revision: draft.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', draftId)
          .where('revision', '=', draft.revision)
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'scheduling.publication_failed',
          targetType: 'schedule_draft',
          targetId: draftId,
          beforeRevision: draft.revision,
          afterRevision: draft.revision + 1,
          correlationId: correlationId ?? null,
          operationId,
          details: { code: error.code },
        });
      }
      const operation = await trx
        .selectFrom('operations')
        .select('status')
        .where('id', '=', operationId)
        .executeTakeFirst();
      if (operation && operation.status === 'running') {
        await this.operations.transition(trx, operationId, 'failed', {
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
    });
  }

  /** Validates and resolves every change against current records; `strict` also treats warnings as issues for the report. */
  private async plan(
    trx: Trx,
    organizationId: string,
    facility: FacilityRow,
    draft: DraftRow,
    strict = false,
  ): Promise<{
    plans: PlannedChange[];
    result: ValidationResult;
    stale: { expected: number; actual: number } | null;
  }> {
    const changes = await this.loadChanges(trx, organizationId, draft.id);
    const issues: ValidationIssue[] = [];
    const plans: PlannedChange[] = [];
    let stale: { expected: number; actual: number } | null = null;
    const seenTargets = new Set<string>();
    const resourceCache = new Map<
      string,
      { id: string; name: string; default_setup_minutes: number; default_cleanup_minutes: number }
    >();
    const loadResources = async (ids: string[]) => {
      const missing = ids.filter((id) => !resourceCache.has(id));
      if (missing.length > 0) {
        const rows = await trx
          .selectFrom('resources')
          .select(['id', 'name', 'default_setup_minutes', 'default_cleanup_minutes'])
          .where('organization_id', '=', organizationId)
          .where('facility_id', '=', facility.id)
          .where('id', 'in', missing)
          .execute();
        for (const row of rows) resourceCache.set(row.id, row);
      }
      return ids.map((id) => resourceCache.get(id));
    };

    for (const change of changes) {
      const sequence = change.sequence;
      const proposed = ProposedEventFieldsSchema.parse(change.proposed);
      let target: EventRow | null = null;
      if (change.target_event_id) {
        if (seenTargets.has(change.target_event_id)) {
          issues.push({
            severity: 'error',
            code: 'duplicate_target',
            message: 'Two changes target the same event.',
            changeSequence: sequence,
            eventId: change.target_event_id,
          });
          continue;
        }
        seenTargets.add(change.target_event_id);
        target =
          (await this.writer.loadEvent(trx, organizationId, change.target_event_id, {
            forUpdate: strict,
          })) ?? null;
        if (!target || target.facility_id !== facility.id) {
          issues.push({
            severity: 'error',
            code: 'missing_target',
            message: 'The target event no longer exists in this facility.',
            changeSequence: sequence,
            eventId: change.target_event_id,
          });
          continue;
        }
        if (target.revision !== change.base_event_revision) {
          stale ??= { expected: change.base_event_revision ?? 0, actual: target.revision };
          issues.push({
            severity: 'error',
            code: 'stale_revision',
            message: 'The event changed since the draft captured it.',
            changeSequence: sequence,
            eventId: target.id,
          });
          continue;
        }
        const requiredStatus = change.kind === 'create' ? 'draft' : 'published';
        if (target.status !== requiredStatus) {
          issues.push({
            severity: 'error',
            code: 'event_status',
            message: `The event is ${target.status}; a ${change.kind} change needs a ${requiredStatus} event.`,
            changeSequence: sequence,
            eventId: target.id,
          });
          continue;
        }
        if (change.kind === 'cancel') {
          EventMachine.next(target.status, 'cancel');
          plans.push({ change, target, fields: null, proposal: null });
          continue;
        }
      }
      const resourceIds =
        change.proposed_resource_ids.length > 0
          ? change.proposed_resource_ids
          : (target?.resource_ids ?? []);
      const resources = await loadResources(resourceIds);
      const missing = resourceIds.filter((_, i) => !resources[i]);
      if (resourceIds.length === 0 || missing.length > 0) {
        issues.push({
          severity: 'error',
          code: 'unknown_resource',
          message: 'A proposed resource does not exist in this facility.',
          changeSequence: sequence,
          eventId: target?.id,
        });
        continue;
      }
      const known = resources.filter((r): r is NonNullable<typeof r> => !!r);
      const fields = this.resolveFields(change, proposed, target, known);
      if (!fields) {
        issues.push({
          severity: 'error',
          code: 'incomplete_change',
          message: 'The change does not define a complete event.',
          changeSequence: sequence,
          eventId: target?.id,
        });
        continue;
      }
      if (!(fields.scheduledStart < fields.scheduledEnd)) {
        issues.push({
          severity: 'error',
          code: 'invalid_interval',
          message: 'start must be before end.',
          changeSequence: sequence,
          eventId: target?.id,
        });
        continue;
      }
      plans.push({
        change,
        target,
        fields,
        proposal: {
          key: String(sequence),
          changeSequence: sequence,
          eventId: target?.id ?? null,
          kind: fields.kind,
          format: fields.format,
          scheduledStart: fields.scheduledStart,
          scheduledEnd: fields.scheduledEnd,
          setupMinutes: fields.setupMinutes,
          cleanupMinutes: fields.cleanupMinutes,
          resourceIds: fields.resourceIds,
          commitments: fields.commitments,
        },
      });
    }

    const proposals = plans.map((p) => p.proposal).filter((p): p is ProposedEvent => p !== null);
    const conflicts = await this.detector.detect(
      trx,
      organizationId,
      { id: facility.id, timezone: facility.timezone },
      proposals,
      {
        policy: this.writer.policyFor(facility),
        ignoreEventIds: plans.map((p) => p.target?.id).filter((id): id is string => !!id),
      },
    );
    for (const c of conflicts) {
      const plan = plans.find((p) => p.proposal?.key === c.key);
      issues.push({
        severity: c.severity,
        code: c.detail.code,
        message: c.detail.message,
        changeSequence: plan?.change.sequence,
        eventId: plan?.target?.id,
        detail: c.detail,
      });
    }
    const ok = !issues.some((i) => i.severity === 'error');
    return { plans, result: { ok, validatedAt: this.clock.now().toISOString(), issues }, stale };
  }

  private resolveFields(
    change: ChangeRow,
    proposed: ProposedEventFields,
    target: EventRow | null,
    resources: Array<{
      id: string;
      default_setup_minutes: number;
      default_cleanup_minutes: number;
    }>,
  ): ResolvedFields | null {
    const defaults = {
      setupMinutes: Math.max(0, ...resources.map((r) => r.default_setup_minutes)),
      cleanupMinutes: Math.max(0, ...resources.map((r) => r.default_cleanup_minutes)),
    };
    const kind = proposed.kind ?? target?.kind;
    const title = proposed.title ?? target?.title;
    if (!kind || !title) return null;
    const scheduledStart = proposed.scheduledStart
      ? new Date(proposed.scheduledStart)
      : target
        ? new Date(target.scheduled_start)
        : null;
    const scheduledEnd = proposed.scheduledEnd
      ? new Date(proposed.scheduledEnd)
      : target
        ? new Date(target.scheduled_end)
        : null;
    if (!scheduledStart || !scheduledEnd) return null;
    const onlyResources = change.kind === 'resource_change';
    return {
      kind,
      title,
      format: proposed.format === undefined ? (target?.format ?? null) : proposed.format,
      scheduledStart: onlyResources && target ? new Date(target.scheduled_start) : scheduledStart,
      scheduledEnd: onlyResources && target ? new Date(target.scheduled_end) : scheduledEnd,
      setupMinutes: proposed.setupMinutes ?? target?.setup_minutes ?? defaults.setupMinutes,
      cleanupMinutes: proposed.cleanupMinutes ?? target?.cleanup_minutes ?? defaults.cleanupMinutes,
      resourceIds: resources.map((r) => r.id),
      commitments: proposed.commitments ?? (target ? this.writer.commitmentsOf(target) : []),
      sourceType: proposed.sourceType ?? target?.source_type ?? null,
      sourceId: proposed.sourceId ?? target?.source_id ?? null,
    };
  }

  private async applyChange(
    trx: Trx,
    organizationId: string,
    facility: FacilityRow,
    plan: PlannedChange,
  ) {
    const { change, target, fields } = plan;
    const sequence = change.sequence;
    const proposed = ProposedEventFieldsSchema.parse(change.proposed);
    if (change.kind === 'cancel' || !fields) {
      const event = target as EventRow;
      const before = await this.writer.details(trx, event);
      const canceled = await this.writer.cancel(
        trx,
        event,
        proposed.reason ?? 'Canceled by schedule publication',
      );
      return {
        sequence,
        kind: change.kind,
        event: canceled,
        change: 'canceled' as const,
        before,
        after: null,
      };
    }
    if (!target) {
      const event = await this.writer.insertEvent(trx, {
        organizationId,
        facilityId: facility.id,
        timezone: facility.timezone,
        ...fields,
        status: 'published',
      });
      await this.writer.reserve(trx, event, facility);
      return {
        sequence,
        kind: change.kind,
        event,
        change: 'created' as const,
        before: null,
        after: await this.writer.details(trx, event),
      };
    }
    const before = await this.writer.details(trx, target);
    const nextStatus =
      change.kind === 'create' ? EventMachine.next(target.status, 'publish') : target.status;
    const updated = await trx
      .updateTable('events')
      .set({
        kind: fields.kind,
        title: fields.title,
        format: fields.format,
        scheduled_start: fields.scheduledStart,
        scheduled_end: fields.scheduledEnd,
        setup_minutes: fields.setupMinutes,
        cleanup_minutes: fields.cleanupMinutes,
        resource_ids: fields.resourceIds,
        commitments: json(fields.commitments),
        source_type: fields.sourceType,
        source_id: fields.sourceId,
        status: nextStatus,
        revision: target.revision + 1,
        published_revision: target.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', target.id)
      .where('revision', '=', target.revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.writer.reserve(trx, updated, facility);
    const changeKind: EventChangeKind =
      change.kind === 'create'
        ? 'published'
        : change.kind === 'move'
          ? 'moved'
          : change.kind === 'resize'
            ? 'resized'
            : 'resource_changed';
    return {
      sequence,
      kind: change.kind,
      event: updated,
      change: changeKind,
      before: change.kind === 'create' ? null : before,
      after: await this.writer.details(trx, updated),
    };
  }

  /** Inserts the change list, capturing each target event's current revision as the draft's base. */
  private async replaceChanges(
    trx: Trx,
    organizationId: string,
    facilityId: string,
    draftId: string,
    inputs: DraftChangeInput[],
  ): Promise<Record<string, number>> {
    const eventRevisions: Record<string, number> = {};
    let sequence = 0;
    for (const input of inputs) {
      sequence += 1;
      let baseRevision: number | null = null;
      if (input.targetEventId) {
        const event = await this.writer.loadEvent(trx, organizationId, input.targetEventId);
        if (!event || event.facility_id !== facilityId) {
          throw errors.validation('Unknown target event for this facility.', {
            changeSequence: sequence,
            targetEventId: input.targetEventId,
          });
        }
        baseRevision = event.revision;
        eventRevisions[event.id] = event.revision;
      }
      await trx
        .insertInto('draft_changes')
        .values({
          id: newId(),
          organization_id: organizationId,
          draft_id: draftId,
          sequence,
          kind: input.kind,
          target_event_id: input.targetEventId ?? null,
          base_event_revision: baseRevision,
          proposed: json(input.proposed ?? {}),
          proposed_resource_ids: input.resourceIds ?? [],
        })
        .execute();
    }
    return eventRevisions;
  }

  private async load(
    db: Trx | Db,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<DraftRow | undefined> {
    let q = db
      .selectFrom('schedule_drafts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async loadChanges(
    db: Trx | Db,
    organizationId: string,
    draftId: string,
  ): Promise<ChangeRow[]> {
    return db
      .selectFrom('draft_changes')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('draft_id', '=', draftId)
      .orderBy('sequence')
      .execute();
  }

  private changeView(row: ChangeRow): DraftChange {
    return {
      sequence: row.sequence,
      kind: row.kind,
      targetEventId: row.target_event_id,
      baseEventRevision: row.base_event_revision,
      proposed: ProposedEventFieldsSchema.parse(row.proposed),
      resourceIds: row.proposed_resource_ids,
    };
  }

  private async view(
    db: Trx | Db,
    organizationId: string,
    draftId: string,
  ): Promise<ScheduleDraft> {
    const row = await this.load(db, organizationId, draftId);
    if (!row) throw errors.notFound('schedule draft', draftId);
    const changes = await this.loadChanges(db, organizationId, draftId);
    const author = row.author as { kind?: string; accountId?: string | null; actorLabel?: string };
    return {
      id: row.id,
      facilityId: row.facility_id,
      name: row.name,
      status: row.status,
      author: {
        kind: author.kind ?? 'unknown',
        accountId: author.accountId ?? null,
        actorLabel: author.actorLabel ?? '',
      },
      baseRevision: row.base_revision,
      changes: changes.map((c) => this.changeView(c)),
      validationResults: (row.validation_results as ValidationResult | null) ?? null,
      lastSavedAt: new Date(row.last_saved_at).toISOString(),
      validatedAt: row.validated_at ? new Date(row.validated_at).toISOString() : null,
      publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      publicationGroupId: row.publication_group_id,
      revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
}

function obligationView(o: FixtureObligation) {
  return { code: o.code, message: o.message, owner: o.owner, deadline: o.deadline };
}

function isIssueDetails(details: unknown): details is { issues: ValidationIssue[] } {
  return (
    typeof details === 'object' &&
    details !== null &&
    Array.isArray((details as { issues?: unknown }).issues)
  );
}

export function publicationView(row: PublicationRow): Publication {
  const summary = row.summary as Publication['summary'];
  return {
    id: row.id,
    draftId: row.draft_id,
    facilityId: row.facility_id,
    operationId: row.operation_id,
    committedAt: new Date(row.committed_at).toISOString(),
    eventIds: row.event_ids,
    noticeEventIds: row.notice_event_ids,
    summary: {
      changes: summary?.changes ?? [],
      remainingObligations: summary?.remainingObligations ?? [],
    },
  };
}
