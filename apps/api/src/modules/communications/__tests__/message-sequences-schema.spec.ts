import { ScheduledMessageMachine, newId } from '@sportspark/contracts';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  pgErrorCode,
  seedOrganization,
  type Db,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { IdentityModule } from '../../identity';

const RESTRICT_VIOLATION = '23001';
const STATES = ScheduledMessageMachine.states;
type State = (typeof STATES)[number];

/**
 * SPK-COMMS-009 (proposed amendment PA-05), migration 1013: integrity that matters is enforced by
 * the database (engineering conventions, §4.7). Each test proves PostgreSQL refuses the violation
 * whatever a service does.
 */
describe('message templates and sequences: schema invariants (migration 1013, SPK-COMMS-009)', () => {
  let t: TestApp;
  let db: Db;
  let org: string;
  const actor = json({ kind: 'system', actorLabel: 'test' });

  beforeAll(async () => {
    t = await createTestApp({ imports: [IdentityModule], clockStart: '2026-11-01T12:00:00Z' });
    db = t.db;
    org = t.organizationId;
  });
  afterAll(async () => {
    await t.close();
  });

  const now = () => t.clock.now();

  async function template(
    over: { organizationId?: string; name?: string; status?: 'active' | 'archived' } = {},
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('message_templates')
      .values({
        id,
        organization_id: over.organizationId ?? org,
        name: over.name ?? `Template ${id}`,
        category: 'operational',
        title: 'Welcome to {{season_name}}',
        body: 'The first game is on {{first_game_date}}.',
        status: over.status ?? 'active',
        created_by: actor,
      })
      .execute();
    return id;
  }

  async function sequence(
    over: { organizationId?: string; facilityId?: string; name?: string } = {},
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('message_sequences')
      .values({
        id,
        organization_id: over.organizationId ?? org,
        facility_id: over.facilityId ?? t.facilityId,
        name: over.name ?? `Sequence ${id}`,
        subject_type: 'season',
        scope_id: null,
        active: true,
        created_by: actor,
      })
      .execute();
    return id;
  }

  async function step(
    sequenceId: string,
    templateId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('message_sequence_steps')
      .values({
        id,
        organization_id: org,
        sequence_id: sequenceId,
        template_id: templateId,
        position: 1,
        anchor: 'starts',
        offset_days: -7,
        send_time_local: null,
        retired_at: null,
        ...over,
      } as never)
      .execute();
    return id;
  }

  async function chain() {
    const templateId = await template();
    const sequenceId = await sequence();
    const stepId = await step(sequenceId, templateId);
    return { templateId, sequenceId, stepId };
  }

  async function scheduled(
    refs: { sequenceId: string; stepId: string },
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const id = newId();
    await db
      .insertInto('scheduled_messages')
      .values({
        id,
        organization_id: org,
        facility_id: t.facilityId,
        sequence_id: refs.sequenceId,
        sequence_step_id: refs.stepId,
        subject_type: 'season',
        subject_id: newId(),
        anchor_at: new Date('2027-01-10T08:00:00Z'),
        due_at: new Date('2027-01-03T17:00:00Z'),
        ...over,
      } as never)
      .execute();
    return id;
  }

  const CONFIRMED = () => ({
    status: 'confirmed' as const,
    confirmed_title: 'Welcome to Winter league',
    confirmed_body: 'The first game is on Sunday, January 10, 2027.',
    confirmed_by: actor,
    confirmed_at: now(),
  });

  async function notification(organizationId = org): Promise<string> {
    const id = newId();
    await db
      .insertInto('notifications')
      .values({
        id,
        organization_id: organizationId,
        facility_id: null,
        kind: 'staff_broadcast',
        category: 'operational',
        subject_type: null,
        subject_id: null,
        audience: json({ staffRoles: ['general_manager'] }),
        title: 'Title',
        body: 'Body',
        created_by: actor,
        created_by_person_id: null,
        source_event_id: null,
        scheduled_for: null,
        supersedes_notification_id: null,
        superseded_by_notification_id: null,
        suppression_reason: null,
        queued_at: null,
        dispatched_at: null,
        suppressed_at: null,
        correlation_id: null,
        operation_id: null,
      })
      .execute();
    return id;
  }

  const update = (id: string, patch: Record<string, unknown>) =>
    db
      .updateTable('scheduled_messages')
      .set(patch as never)
      .where('id', '=', id)
      .execute();

  /** Brings a fresh message to the state through moves the guard allows. */
  async function messageIn(state: State): Promise<string> {
    const id = await scheduled(await chain());
    if (state === 'needs_confirmation') return id;
    if (state === 'skipped') {
      await update(id, { status: 'skipped', skipped_by: actor, skipped_at: now() });
      return id;
    }
    if (state === 'canceled') {
      await update(id, { status: 'canceled', canceled_at: now(), cancel_reason: 'step_removed' });
      return id;
    }
    await update(id, CONFIRMED());
    if (state === 'sent') {
      await update(id, { status: 'sent', notification_id: await notification(), sent_at: now() });
    }
    return id;
  }

  /** The columns each target state needs, so only the move itself is judged. */
  async function moveTo(id: string, to: State): Promise<void> {
    const clear = {
      confirmed_title: null,
      confirmed_body: null,
      confirmed_by: null,
      confirmed_at: null,
      skipped_by: null,
      skipped_at: null,
      skip_reason: null,
      canceled_at: null,
      cancel_reason: null,
      notification_id: null,
      sent_at: null,
    };
    const facts: Record<State, Record<string, unknown>> = {
      needs_confirmation: clear,
      confirmed: { ...clear, ...CONFIRMED() },
      skipped: { ...clear, skipped_by: actor, skipped_at: now() },
      canceled: { ...clear, canceled_at: now(), cancel_reason: 'record_archived' },
      sent: { ...CONFIRMED(), notification_id: await notification(), sent_at: now() },
    };
    await update(id, { ...facts[to], status: to });
  }

  it('SPK-COMMS-009: a second scheduled message for the same step and season is refused (a replay creates nothing twice)', async () => {
    const refs = await chain();
    const subjectId = newId();
    await scheduled(refs, { subject_id: subjectId });
    const error = await scheduled(refs, { subject_id: subjectId }).catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(pgConstraintName(error)).toBe('scheduled_messages_step_subject_idx');
    // the same step for another season, and the same id as an offering, are other messages
    await scheduled(refs, { subject_id: newId() });
    await scheduled(refs, { subject_id: subjectId, subject_type: 'offering' });
  });

  it('SPK-COMMS-009: the states are exactly the machine states, and a message cannot be inserted in any but the first', async () => {
    const refs = await chain();
    const unknown = await scheduled(refs, { status: 'queued' }).catch((e: unknown) => e);
    expect(isCheckViolation(unknown)).toBe(true);
    for (const state of STATES.filter((s) => s !== ScheduledMessageMachine.initial)) {
      const error = await scheduled(await chain(), {
        status: state,
        ...(state === 'confirmed' || state === 'sent' ? CONFIRMED() : {}),
        ...(state === 'sent' ? { notification_id: await notification(), sent_at: now() } : {}),
        ...(state === 'skipped' ? { skipped_by: actor, skipped_at: now() } : {}),
        ...(state === 'canceled' ? { canceled_at: now(), cancel_reason: 'step_removed' } : {}),
      }).catch((e: unknown) => e);
      expect(isCheckViolation(error), state).toBe(true);
      expect(pgConstraintName(error), state).toBe('scheduled_messages_machine');
    }
  });

  it('SPK-COMMS-009: the database allows exactly the moves ScheduledMessageMachine allows', async () => {
    for (const from of STATES) {
      for (const to of STATES) {
        if (from === to) continue;
        const id = await messageIn(from);
        const allowed = Object.values(ScheduledMessageMachine.transitions[from]).includes(to);
        const error = await moveTo(id, to).then(
          () => null,
          (e: unknown) => e,
        );
        const label = `${from} -> ${to}`;
        if (allowed) {
          expect(error, label).toBeNull();
        } else if (ScheduledMessageMachine.isTerminal(from)) {
          // a sent or canceled message is never changed at all
          expect(pgErrorCode(error), label).toBe(RESTRICT_VIOLATION);
        } else {
          expect(isCheckViolation(error), label).toBe(true);
          expect(pgConstraintName(error), label).toBe('scheduled_messages_machine');
        }
      }
    }
  });

  it('SPK-COMMS-009: a sent message cannot be edited, re-pointed, rescheduled or deleted', async () => {
    const id = await messageIn('sent');
    for (const patch of [
      { edited_title: 'Changed', edited_body: 'Changed', edited_by: actor, edited_at: now() },
      { confirmed_title: 'Another title' },
      { confirmed_body: 'Another text' },
      { due_at: new Date('2027-02-01T17:00:00Z') },
      { notification_id: await notification() },
      { revision: 9 },
    ]) {
      const error = await update(id, patch).catch((e: unknown) => e);
      expect(pgErrorCode(error), JSON.stringify(Object.keys(patch))).toBe(RESTRICT_VIOLATION);
    }
    const removed = await db
      .deleteFrom('scheduled_messages')
      .where('id', '=', id)
      .execute()
      .catch((e: unknown) => e);
    expect(removed).toBeInstanceOf(Error);
    const row = await db
      .selectFrom('scheduled_messages')
      .select(['status', 'confirmed_title', 'revision'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: 'sent',
      confirmed_title: 'Welcome to Winter league',
      revision: 1,
    });
  });

  it('SPK-COMMS-009: a message cannot change its step, its sequence or the record it is about', async () => {
    const id = await scheduled(await chain());
    const other = await chain();
    for (const patch of [
      { sequence_id: other.sequenceId, sequence_step_id: other.stepId },
      { subject_id: newId() },
      { subject_type: 'offering' },
    ]) {
      const error = await update(id, patch).catch((e: unknown) => e);
      expect(pgErrorCode(error), JSON.stringify(patch)).toBe(RESTRICT_VIOLATION);
    }
  });

  it('SPK-COMMS-009: a confirmed message carries the confirmed text, who and when, and a due time; no other state keeps them', async () => {
    const id = await scheduled(await chain());
    // confirmed without the text
    expect(
      isCheckViolation(await update(id, { status: 'confirmed' }).catch((e: unknown) => e)),
    ).toBe(true);
    // confirmed without a due time
    const undated = await scheduled(await chain(), { anchor_at: null, due_at: null });
    const noDue = await update(undated, CONFIRMED()).catch((e: unknown) => e);
    expect(isCheckViolation(noDue)).toBe(true);
    expect(pgConstraintName(noDue)).toBe('scheduled_messages_confirmed_fact');
    // text kept on a message that is not confirmed
    const stale = await update(id, {
      confirmed_title: 'Kept',
      confirmed_body: 'Kept',
      confirmed_by: actor,
      confirmed_at: now(),
    }).catch((e: unknown) => e);
    expect(isCheckViolation(stale)).toBe(true);
    // a due time without its anchor date
    const halfDated = await update(id, { anchor_at: null }).catch((e: unknown) => e);
    expect(pgConstraintName(halfDated)).toBe('scheduled_messages_due_with_anchor');
  });

  it('SPK-COMMS-009: a confirmed text never holds raw placeholder marks', async () => {
    for (const text of [
      { confirmed_title: 'Welcome to {{season_name}}' },
      { confirmed_body: 'See you at {{field}}.' },
      { confirmed_body: 'A stray }} mark' },
    ]) {
      const id = await scheduled(await chain());
      const error = await update(id, { ...CONFIRMED(), ...text }).catch((e: unknown) => e);
      expect(isCheckViolation(error), JSON.stringify(text)).toBe(true);
      expect(pgConstraintName(error)).toBe('scheduled_messages_no_raw_placeholder');
    }
  });

  it('SPK-COMMS-009: sent needs the notification it produced, a notification belongs to one message, and other states name none', async () => {
    const id = await messageIn('confirmed');
    const withoutNotice = await update(id, { status: 'sent', sent_at: now() }).catch(
      (e: unknown) => e,
    );
    expect(pgConstraintName(withoutNotice)).toBe('scheduled_messages_sent_fact');
    const early = await update(id, { notification_id: await notification() }).catch(
      (e: unknown) => e,
    );
    expect(pgConstraintName(early)).toBe('scheduled_messages_sent_fact');
    const notice = await notification();
    await update(id, { status: 'sent', notification_id: notice, sent_at: now() });
    const second = await messageIn('confirmed');
    const reused = await update(second, {
      status: 'sent',
      notification_id: notice,
      sent_at: now(),
    }).catch((e: unknown) => e);
    expect(isUniqueViolation(reused)).toBe(true);
  });

  it('SPK-COMMS-009: an edited copy is a title and a body together, with who edited and when', async () => {
    const id = await scheduled(await chain());
    const half = await update(id, { edited_title: 'Only a title' }).catch((e: unknown) => e);
    expect(pgConstraintName(half)).toBe('scheduled_messages_edit_complete');
    const anonymous = await update(id, { edited_title: 'Title', edited_body: 'Body' }).catch(
      (e: unknown) => e,
    );
    expect(pgConstraintName(anonymous)).toBe('scheduled_messages_edit_complete');
    await update(id, {
      edited_title: 'Title',
      edited_body: 'Body',
      edited_by: actor,
      edited_at: now(),
    });
  });

  it('SPK-COMMS-009: skipped and canceled carry their facts, and attention belongs to a message that needs confirmation', async () => {
    const id = await scheduled(await chain());
    expect(pgConstraintName(await update(id, { status: 'skipped' }).catch((e: unknown) => e))).toBe(
      'scheduled_messages_skipped_fact',
    );
    expect(
      pgConstraintName(await update(id, { status: 'canceled' }).catch((e: unknown) => e)),
    ).toBe('scheduled_messages_canceled_fact');
    expect(
      isCheckViolation(await update(id, { attention: 'because' }).catch((e: unknown) => e)),
    ).toBe(true);
    const confirmed = await messageIn('confirmed');
    expect(
      pgConstraintName(
        await update(confirmed, { attention: 'anchor_moved' }).catch((e: unknown) => e),
      ),
    ).toBe('scheduled_messages_attention_state');
  });

  it('§4.3: a scheduled message, a step and a sequence cannot point at another organization', async () => {
    const other = await seedOrganization(db, { slug: `other-${newId()}` });
    const foreignTemplate = await template({ organizationId: other.organizationId });
    const foreignSequence = await sequence({
      organizationId: other.organizationId,
      facilityId: other.facilityId,
    });
    const own = await chain();
    // a step of this organization with another organization's template or sequence
    expect(
      isForeignKeyViolation(await step(own.sequenceId, foreignTemplate).catch((e: unknown) => e)),
    ).toBe(true);
    expect(
      isForeignKeyViolation(await step(foreignSequence, own.templateId).catch((e: unknown) => e)),
    ).toBe(true);
    // a sequence at another organization's facility
    expect(
      isForeignKeyViolation(
        await sequence({ facilityId: other.facilityId }).catch((e: unknown) => e),
      ),
    ).toBe(true);
    // a scheduled message at another organization's facility, or naming its sequence
    expect(
      isForeignKeyViolation(
        await scheduled(own, { facility_id: other.facilityId }).catch((e: unknown) => e),
      ),
    ).toBe(true);
    expect(
      isForeignKeyViolation(
        await scheduled({ sequenceId: foreignSequence, stepId: own.stepId }).catch(
          (e: unknown) => e,
        ),
      ),
    ).toBe(true);
    // a step that belongs to another sequence of the same organization
    const second = await chain();
    expect(
      isForeignKeyViolation(
        await scheduled({ sequenceId: own.sequenceId, stepId: second.stepId }).catch(
          (e: unknown) => e,
        ),
      ),
    ).toBe(true);
    // a sent message naming another organization's notification
    const confirmed = await messageIn('confirmed');
    const foreignNotice = await notification(other.organizationId);
    expect(
      isForeignKeyViolation(
        await update(confirmed, {
          status: 'sent',
          notification_id: foreignNotice,
          sent_at: now(),
        }).catch((e: unknown) => e),
      ),
    ).toBe(true);
  });

  it('SPK-COMMS-009, SPK-COMMS-007: one active template per name; a template never changes its category', async () => {
    const id = await template({ name: 'Season welcome' });
    expect(
      isUniqueViolation(await template({ name: 'season WELCOME' }).catch((e: unknown) => e)),
    ).toBe(true);
    // an archived template frees its name
    await template({ name: 'Season welcome', status: 'archived' });
    const recategorized = await db
      .updateTable('message_templates')
      .set({ category: 'promotional' })
      .where('id', '=', id)
      .execute()
      .catch((e: unknown) => e);
    expect(pgErrorCode(recategorized)).toBe(RESTRICT_VIOLATION);
    const unknown = await db
      .insertInto('message_templates')
      .values({
        id: newId(),
        organization_id: org,
        name: 'Other',
        category: 'urgent' as never,
        title: 'T',
        body: 'B',
        created_by: actor,
      })
      .execute()
      .catch((e: unknown) => e);
    expect(isCheckViolation(unknown)).toBe(true);
  });

  it('SPK-COMMS-009: a sequence keeps its facility and kind of record; a step keeps its sequence, a valid anchor, offset and time, and a removed step stays removed', async () => {
    const refs = await chain();
    const moved = await db
      .updateTable('message_sequences')
      .set({ subject_type: 'offering' })
      .where('id', '=', refs.sequenceId)
      .execute()
      .catch((e: unknown) => e);
    expect(pgErrorCode(moved)).toBe(RESTRICT_VIOLATION);
    const other = await sequence();
    const rehomed = await db
      .updateTable('message_sequence_steps')
      .set({ sequence_id: other })
      .where('id', '=', refs.stepId)
      .execute()
      .catch((e: unknown) => e);
    expect(pgErrorCode(rehomed)).toBe(RESTRICT_VIOLATION);
    for (const bad of [
      { anchor: 'kickoff' },
      { offset_days: 400 },
      { send_time_local: '25:00' },
      { send_time_local: '9am' },
      { position: 0 },
    ]) {
      const error = await step(refs.sequenceId, refs.templateId, bad).catch((e: unknown) => e);
      expect(isCheckViolation(error), JSON.stringify(bad)).toBe(true);
    }
    await db
      .updateTable('message_sequence_steps')
      .set({ retired_at: now() })
      .where('id', '=', refs.stepId)
      .execute();
    const revived = await db
      .updateTable('message_sequence_steps')
      .set({ retired_at: null })
      .where('id', '=', refs.stepId)
      .execute()
      .catch((e: unknown) => e);
    expect(pgErrorCode(revived)).toBe(RESTRICT_VIOLATION);
  });
});
