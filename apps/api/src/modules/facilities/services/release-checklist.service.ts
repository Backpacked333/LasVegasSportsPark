import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ActorSnapshot,
  type AddChecklistItemBody,
  type CompleteChecklistItemBody,
  type Principal,
  type ReleaseChecklist,
  type ReleaseChecklistItem,
  type RemoveChecklistItemBody,
  type ReopenChecklistItemBody,
} from '@sportspark/contracts';
import { json, type Db, type RestrictionChecklistItemsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  executorFor,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { FacilitiesActions } from '../facilities.actions';
import {
  FacilitiesReader,
  iso,
  isoOrNull,
  organizationOf,
  type DbHandle,
  type RestrictionRow,
} from './facilities-reader';

type ItemRow = Selectable<RestrictionChecklistItemsTable>;

/** Restriction states whose checklist may still change (migration 0909 guard). */
const OPEN_STATES = new Set(['proposed', 'approved', 'active']);

/** At most this many checklist items per restriction. */
export const CHECKLIST_MAX_ITEMS = 30;

/**
 * Release checklists (migration 0909, SPK-FAC-004 "returning a space to service requires an
 * authorized release", SPK-FAC-002 "resolution and inspection"). A restriction's own checks
 * ("net replaced and tensioned") are added, confirmed, reopened and removed by the staff who
 * manage the restriction, each audited with who and when; the release refuses while one is not
 * confirmed (`assertComplete`, and the database's release guard). Every command locks the
 * restriction row first, the same row the release locks, so a reopen and a release are ordered.
 */
@Injectable()
export class ReleaseChecklistService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly reader: FacilitiesReader,
  ) {}

  /** `GET /v1/maintenance-restrictions/{id}/release-checklist` (`facilities.view_maintenance`). */
  async get(principal: Principal, restrictionId: string): Promise<ReleaseChecklist> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const restriction = await this.reader.loadRestriction(db, organizationId, restrictionId);
    if (!restriction) throw errors.notFound('restriction', restrictionId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'restriction',
      id: restrictionId,
      organizationId,
      facilityId: restriction.facility_id,
    });
    return this.view(db, restriction);
  }

  async addItem(
    principal: Principal,
    restrictionId: string,
    body: AddChecklistItemBody,
    correlationId?: string,
  ): Promise<ReleaseChecklistItem> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const restriction = await this.lockOpen(trx, principal, organizationId, restrictionId);
      const items = await this.items(trx, organizationId, restrictionId);
      if (items.length >= CHECKLIST_MAX_ITEMS) {
        throw errors.validation(`A checklist holds at most ${CHECKLIST_MAX_ITEMS} items.`, {
          code: 'checklist_full',
          limit: CHECKLIST_MAX_ITEMS,
        });
      }
      const now = this.clock.now();
      const row = await trx
        .insertInto('restriction_checklist_items')
        .values({
          id: newId(),
          organization_id: organizationId,
          restriction_id: restriction.id,
          position: items.reduce((max, i) => Math.max(max, i.position + 1), 0),
          label: body.label.trim(),
          created_by: json(snapshotActor(principal)),
          completed_at: null,
          completed_by: null,
          completion_note: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.checklist_item_added',
        targetType: 'restriction',
        targetId: restriction.id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: { itemId: row.id, label: row.label },
      });
      return itemView(row);
    });
  }

  async complete(
    principal: Principal,
    restrictionId: string,
    itemId: string,
    body: CompleteChecklistItemBody,
    correlationId?: string,
  ): Promise<ReleaseChecklist> {
    return this.change(principal, restrictionId, itemId, correlationId, async (trx, item) => {
      assertExpectedRevision(body.expectedRevision, item.revision);
      if (item.completed_at) {
        throw errors.invalidTransition('ReleaseChecklistItem', 'confirmed', 'complete');
      }
      await this.update(trx, item, {
        completed_at: this.clock.now(),
        completed_by: json(snapshotActor(principal)),
        completion_note: body.note?.trim() || null,
      });
      return { action: 'facilities.checklist_item_completed', reason: body.reason ?? null };
    });
  }

  async reopen(
    principal: Principal,
    restrictionId: string,
    itemId: string,
    body: ReopenChecklistItemBody,
    correlationId?: string,
  ): Promise<ReleaseChecklist> {
    return this.change(principal, restrictionId, itemId, correlationId, async (trx, item) => {
      assertExpectedRevision(body.expectedRevision, item.revision);
      if (!item.completed_at) {
        throw errors.invalidTransition('ReleaseChecklistItem', 'open', 'reopen');
      }
      await this.update(trx, item, {
        completed_at: null,
        completed_by: null,
        completion_note: null,
      });
      return { action: 'facilities.checklist_item_reopened', reason: body.reason };
    });
  }

  async remove(
    principal: Principal,
    restrictionId: string,
    itemId: string,
    body: RemoveChecklistItemBody,
    correlationId?: string,
  ): Promise<ReleaseChecklist> {
    return this.change(principal, restrictionId, itemId, correlationId, async (trx, item) => {
      assertExpectedRevision(body.expectedRevision, item.revision);
      // a confirmed check is reopened (explained) before it can be removed
      if (item.completed_at) {
        throw errors.invalidTransition('ReleaseChecklistItem', 'confirmed', 'remove');
      }
      await trx
        .deleteFrom('restriction_checklist_items')
        .where('organization_id', '=', item.organization_id)
        .where('id', '=', item.id)
        .where('revision', '=', item.revision)
        .execute();
      return { action: 'facilities.checklist_item_removed', reason: body.reason };
    });
  }

  /**
   * SPK-FAC-004: the release gate. Inside the release transaction, with the restriction row
   * locked; refuses with ELIGIBILITY_FAILED `checklist_incomplete` naming the open items.
   */
  async assertComplete(trx: Trx, organizationId: string, restrictionId: string): Promise<void> {
    const open = (await this.items(trx, organizationId, restrictionId)).filter(
      (i) => i.completed_at === null,
    );
    if (open.length === 0) return;
    throw errors.eligibility('Every release checklist item must be confirmed before release.', {
      code: 'checklist_incomplete',
      openItems: open.map((i) => ({ id: i.id, label: i.label })),
    });
  }

  private async change(
    principal: Principal,
    restrictionId: string,
    itemId: string,
    correlationId: string | undefined,
    apply: (trx: Trx, item: ItemRow) => Promise<{ action: string; reason: string | null }>,
  ): Promise<ReleaseChecklist> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const restriction = await this.lockOpen(trx, principal, organizationId, restrictionId);
      const item = await trx
        .selectFrom('restriction_checklist_items')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('restriction_id', '=', restrictionId)
        .where('id', '=', itemId)
        .forUpdate()
        .executeTakeFirst();
      if (!item) throw errors.notFound('checklist item', itemId);
      const { action, reason } = await apply(trx, item);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action,
        targetType: 'restriction',
        targetId: restriction.id,
        beforeRevision: item.revision,
        ...(action.endsWith('_removed') ? {} : { afterRevision: item.revision + 1 }),
        reason,
        correlationId: correlationId ?? null,
        details: { itemId: item.id, label: item.label },
      });
      return this.view(trx, restriction);
    });
  }

  private async update(
    trx: Trx,
    item: ItemRow,
    set: Pick<ItemRow, 'completion_note'> & {
      completed_at: Date | null;
      completed_by: ReturnType<typeof json> | null;
    },
  ): Promise<void> {
    const updated = await trx
      .updateTable('restriction_checklist_items')
      .set({ ...set, revision: item.revision + 1, updated_at: this.clock.now() })
      .where('organization_id', '=', item.organization_id)
      .where('id', '=', item.id)
      .where('revision', '=', item.revision)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw errors.staleRevision(item.revision, item.revision + 1);
    }
  }

  /** Locks the restriction (the row the release locks) and checks authority and its state. */
  private async lockOpen(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    restrictionId: string,
  ): Promise<RestrictionRow> {
    const restriction = await this.reader.loadRestriction(trx, organizationId, restrictionId, true);
    if (!restriction) throw errors.notFound('restriction', restrictionId);
    await this.authorization.require(principal, FacilitiesActions.manageReleaseChecklist, {
      type: 'restriction',
      id: restrictionId,
      organizationId,
      facilityId: restriction.facility_id,
    });
    if (!OPEN_STATES.has(restriction.status)) {
      throw errors.invalidTransition('Restriction', restriction.status, 'edit checklist');
    }
    return restriction;
  }

  private items(db: DbHandle, organizationId: string, restrictionId: string): Promise<ItemRow[]> {
    return db
      .selectFrom('restriction_checklist_items')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('restriction_id', '=', restrictionId)
      .orderBy('position')
      .execute();
  }

  private async view(db: DbHandle, restriction: RestrictionRow): Promise<ReleaseChecklist> {
    const organizationId = restriction.organization_id;
    const items = await this.items(db, organizationId, restriction.id);
    let taskOwner: ReleaseChecklist['taskOwner'] = null;
    if (restriction.task_id) {
      const task = await this.reader.loadTask(db, organizationId, restriction.task_id);
      const ownerId = task?.assigned_owner_person_id ?? null;
      if (ownerId) {
        const names = await this.persons.displayNames(organizationId, [ownerId]);
        taskOwner = { personId: ownerId, displayName: names.get(ownerId)?.displayName ?? null };
      }
    }
    return {
      restrictionId: restriction.id,
      restrictionStatus: restriction.status,
      items: items.map(itemView),
      complete: items.every((i) => i.completed_at !== null),
      taskOwner,
    };
  }
}

function itemView(row: ItemRow): ReleaseChecklistItem {
  return {
    id: row.id,
    restrictionId: row.restriction_id,
    position: row.position,
    label: row.label,
    createdBy: row.created_by as unknown as ActorSnapshot,
    completedAt: isoOrNull(row.completed_at),
    completedBy: (row.completed_by as unknown as ActorSnapshot | null) ?? null,
    completionNote: row.completion_note,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
