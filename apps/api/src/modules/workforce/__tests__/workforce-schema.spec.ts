import { newId } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { at } from '../../scheduling';
import { createAssignmentFixture, createAvailabilityFixture } from '../testing/workforce-fixtures';
import {
  competitionWorld,
  expectPgError,
  scheduleFixture,
  workforceTestApp,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

/**
 * Integrity invariants enforced by the database (migration 0700), proven by writing violating
 * rows directly: the services' checks give earlier feedback but are not the guarantee (§4.7).
 */
describe('workforce schema invariants (migration 0700)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let game: ScheduledFixture;
  let later: ScheduledFixture;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    game = await scheduleFixture(t, world, { date: '2027-02-01', from: '10:00', to: '11:00' });
    later = await scheduleFixture(t, world, { date: '2027-02-01', from: '11:20', to: '12:20' });
  });
  afterAll(async () => {
    await t.close();
  });

  const person = () => createPersonFixture(t, { kind: 'adult' });
  const fixtureTarget = (f: ScheduledFixture) => ({
    targetType: 'fixture' as const,
    targetId: f.fixtureId,
    scheduledStart: f.start,
    scheduledEnd: f.end,
  });

  it('SPK-STAFF-003: overlapping accepted assignments of one person are rejected by the exclusion constraint', async () => {
    const official = await person();
    await createAssignmentFixture(t, {
      ...fixtureTarget(game),
      personId: official,
      status: 'accepted',
      role: 'referee',
    });
    await expectPgError(
      createAssignmentFixture(t, {
        targetType: 'event',
        targetId: game.eventId,
        scheduledStart: at('2027-02-01', '10:30'),
        scheduledEnd: at('2027-02-01', '11:30'),
        personId: official,
        status: 'accepted',
        role: 'observer',
      }),
      '23P01',
    );
    // proposed and offered assignments hold nothing
    await createAssignmentFixture(t, {
      targetType: 'event',
      targetId: game.eventId,
      scheduledStart: at('2027-02-01', '10:30'),
      scheduledEnd: at('2027-02-01', '11:30'),
      personId: official,
      status: 'offered',
      role: 'observer',
    });
  });

  it('SPK-STAFF-003: the held interval includes the turnaround, so a too-close accepted assignment is rejected', async () => {
    const official = await person();
    await createAssignmentFixture(t, {
      ...fixtureTarget(game),
      personId: official,
      status: 'accepted',
      role: 'assistant_referee',
      turnaroundMinutes: 30,
    });
    // `later` starts 20 minutes after `game` ends: inside the 30-minute turnaround
    await expectPgError(
      createAssignmentFixture(t, {
        ...fixtureTarget(later),
        personId: official,
        status: 'accepted',
        role: 'referee',
      }),
      '23P01',
    );
    // with a 15-minute turnaround on the first game it would fit
    const other = await person();
    await createAssignmentFixture(t, {
      ...fixtureTarget(game),
      personId: other,
      status: 'accepted',
      role: 'fourth_official',
      turnaroundMinutes: 15,
    });
    await createAssignmentFixture(t, {
      ...fixtureTarget(later),
      personId: other,
      status: 'accepted',
      role: 'fourth_official',
    });
  });

  it('SPK-STAFF-002: one accepted (or completed) assignment per role slot; one live assignment per person per slot', async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    await createAssignmentFixture(t, {
      ...fixtureTarget(later),
      personId: a,
      status: 'accepted',
      role: 'match_commissioner',
    });
    await expectPgError(
      createAssignmentFixture(t, {
        ...fixtureTarget(later),
        personId: b,
        status: 'accepted',
        role: 'match_commissioner',
      }),
      '23505',
    );
    // several people may be offered the same slot; only acceptance is exclusive
    await createAssignmentFixture(t, {
      ...fixtureTarget(later),
      personId: b,
      status: 'offered',
      role: 'match_commissioner',
    });
    await createAssignmentFixture(t, {
      ...fixtureTarget(later),
      personId: c,
      status: 'offered',
      role: 'match_commissioner',
    });
    await expectPgError(
      createAssignmentFixture(t, {
        ...fixtureTarget(later),
        personId: c,
        status: 'proposed',
        role: 'match_commissioner',
      }),
      '23505',
    );
  });

  it('§4.6: status values are exactly the Assignment machine states and each state carries its fact', async () => {
    const p = await person();
    const id = await createAssignmentFixture(t, {
      ...fixtureTarget(game),
      personId: p,
      status: 'proposed',
      role: 'timekeeper',
    });
    await expectPgError(
      t.db
        .updateTable('assignments')
        .set({ status: 'approved' as never })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
    // accepted without the acceptance instant
    await expectPgError(
      t.db
        .updateTable('assignments')
        .set({ status: 'accepted', offered_at: new Date() })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
    // withdrawn without a reason
    await expectPgError(
      t.db
        .updateTable('assignments')
        .set({ status: 'withdrawn', withdrawn_at: new Date() })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
    // the held interval must equal the scheduled end plus the turnaround
    await expectPgError(
      t.db
        .updateTable('assignments')
        .set({ committed_end: new Date(new Date(game.end).getTime() + 5 * 60_000) })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
    // regular engagements never carry access
    await expectPgError(
      t.db
        .updateTable('assignments')
        .set({ access_status: 'pending' })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
  });

  it('SPK-STAFF-004: work records are never deleted', async () => {
    const p = await person();
    const id = await createAssignmentFixture(t, {
      ...fixtureTarget(game),
      personId: p,
      status: 'withdrawn',
      role: 'ball_steward',
    });
    await expectPgError(t.db.deleteFrom('assignments').where('id', '=', id).execute(), '23001');
    const windowId = await createAvailabilityFixture(t, {
      personId: p,
      start: at('2027-02-02', '09:00'),
      end: at('2027-02-02', '12:00'),
    });
    await expectPgError(
      t.db.deleteFrom('availability').where('id', '=', windowId).execute(),
      '23001',
    );
  });

  it('SPK-STAFF-001: one active availability statement per person per instant', async () => {
    const p = await person();
    await createAvailabilityFixture(t, {
      personId: p,
      start: at('2027-02-03', '09:00'),
      end: at('2027-02-03', '12:00'),
      kind: 'available',
    });
    await expectPgError(
      createAvailabilityFixture(t, {
        personId: p,
        start: at('2027-02-03', '11:00'),
        end: at('2027-02-03', '13:00'),
        kind: 'unavailable',
      }),
      '23P01',
    );
    // adjacent windows (half-open) are fine
    await createAvailabilityFixture(t, {
      personId: p,
      start: at('2027-02-03', '12:00'),
      end: at('2027-02-03', '13:00'),
      kind: 'unavailable',
    });
  });

  it('§4.3: a row cannot reference another organization’s person or fixture', async () => {
    const other = await seedOrganization(t.db);
    const foreigner = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    await expectPgError(
      createAssignmentFixture(t, { ...fixtureTarget(game), personId: foreigner, role: 'steward' }),
      '23503',
    );
    const local = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    await expectPgError(
      createAssignmentFixture(t, {
        ...fixtureTarget(game),
        personId: local,
        role: 'steward',
        organizationId: other.organizationId,
        facilityId: other.facilityId,
      }),
      '23503',
    );
  });

  it('SPK-STAFF-006: fee adjustments and export batches are append-only; a submission exports only in its batch currency and once live per assignment', async () => {
    const p = await person();
    const assignmentId = await createAssignmentFixture(t, {
      ...fixtureTarget(game),
      personId: p,
      status: 'completed',
      role: 'linesman',
    });
    const submissionId = newId();
    const submission = {
      organization_id: t.organizationId,
      assignment_id: assignmentId,
      person_id: p,
      rate_basis: json({ kind: 'flat', amountMinor: 5000 }),
      computed_amount_minor: 5000,
      submitted_amount_minor: 5000,
      currency: 'USD',
      note: null,
      submitted_by: json({ kind: 'system', actorLabel: 'test' }),
      submitted_at: new Date(),
      approved_amount_minor: 5000,
      approver: json({ kind: 'system', actorLabel: 'test' }),
      approver_person_id: null,
      approved_at: new Date(),
      rejected_at: null,
      rejection_reason: null,
      export_batch_id: null,
      exported_at: null,
    };
    await t.db
      .insertInto('fee_submissions')
      .values({ ...submission, id: submissionId, status: 'approved' })
      .execute();
    await expectPgError(
      t.db
        .insertInto('fee_submissions')
        .values({
          ...submission,
          id: newId(),
          status: 'submitted',
          approved_amount_minor: null,
          approver: null,
          approved_at: null,
        })
        .execute(),
      '23505',
    );
    const adjustmentId = newId();
    await t.db
      .insertInto('fee_adjustments')
      .values({
        id: adjustmentId,
        organization_id: t.organizationId,
        fee_submission_id: submissionId,
        sequence: 1,
        previous_amount_minor: 5000,
        adjusted_amount_minor: 4500,
        currency: 'USD',
        reason: 'Rate card',
        adjusted_by: json({ kind: 'system', actorLabel: 'test' }),
        adjusted_by_person_id: null,
        adjusted_at: new Date(),
      })
      .execute();
    await expectPgError(
      t.db
        .updateTable('fee_adjustments')
        .set({ reason: 'rewritten' })
        .where('id', '=', adjustmentId)
        .execute(),
      '23001',
    );
    await expectPgError(
      t.db.deleteFrom('fee_adjustments').where('id', '=', adjustmentId).execute(),
      '23001',
    );
    const batchId = newId();
    await t.db
      .insertInto('fee_export_batches')
      .values({
        id: batchId,
        organization_id: t.organizationId,
        currency: 'EUR',
        submission_count: 1,
        total_minor: 5000,
        lines: json([]),
        note: null,
        created_by: json({ kind: 'system', actorLabel: 'test' }),
        created_by_person_id: null,
        operation_id: null,
      })
      .execute();
    // a USD submission cannot be exported in a EUR batch
    await expectPgError(
      t.db
        .updateTable('fee_submissions')
        .set({ status: 'exported', export_batch_id: batchId, exported_at: new Date() })
        .where('id', '=', submissionId)
        .execute(),
      '23503',
    );
    await expectPgError(
      t.db.deleteFrom('fee_export_batches').where('id', '=', batchId).execute(),
      '23001',
    );
    expect(true).toBe(true);
  });
});
