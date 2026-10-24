import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions, OperationsService } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { CaseMachine, type CaseEvent } from '../support.machines';
import { createCaseFixture, createExceptionQueueFixture } from '../testing/support-fixtures';
import { expectPgError, otherOrganization, supportTestApp } from './support';

const ACTOR = json({ kind: 'system', actorLabel: 'test' });

/**
 * Integrity invariants enforced by the database (migration 1100), proven by writing violating rows
 * directly: the services check first for earlier feedback, but the database is the guarantee.
 */
describe('support schema invariants (migration 1100)', () => {
  let t: TestApp;
  let other: { organizationId: string; facilityId: string };

  beforeAll(async () => {
    t = await supportTestApp();
    other = await otherOrganization(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const operation = async (organizationId = t.organizationId) =>
    t.db.transaction().execute((trx) =>
      t.app.get(OperationsService).create(trx, {
        organizationId,
        kind: 'test.command',
        requestedBy: systemPrincipal(organizationId),
        status: 'running',
      }),
    );

  const action = (
    caseId: string,
    values: Partial<{
      status: 'requested' | 'succeeded' | 'failed' | 'unknown';
      via: 'linked' | 'helper';
      command_operation_id: string | null;
      audit_record_id: string | null;
      support_operation_id: string | null;
      request_key: string | null;
      completed_at: Date | null;
      error: ReturnType<typeof json> | null;
      organization_id: string;
    }> = {},
  ) =>
    t.db
      .insertInto('case_actions')
      .values({
        id: newId(),
        organization_id: values.organization_id ?? t.organizationId,
        case_id: caseId,
        action_id: 'finance.refund',
        via: values.via ?? 'linked',
        status: values.status ?? 'succeeded',
        command_operation_id: values.command_operation_id ?? null,
        audit_record_id: values.audit_record_id ?? null,
        support_operation_id: values.support_operation_id ?? null,
        record_type: null,
        record_id: null,
        request_key: values.request_key ?? null,
        input: json({}),
        error: values.error ?? null,
        note: null,
        actor: ACTOR,
        actor_person_id: null,
        requested_at: t.clock.now(),
        completed_at: values.completed_at === undefined ? t.clock.now() : values.completed_at,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

  it('SPK-SUPPORT-003: a succeeded case action without the command operation or audit record is rejected', async () => {
    const caseId = await createCaseFixture(t);
    await expectPgError(action(caseId), '23514');
    // With evidence of the executed command it is accepted.
    await action(caseId, { command_operation_id: await operation() });
  });

  it('SPK-SUPPORT-003: a case is resolved as action_taken only with a succeeded authorized command', async () => {
    const caseId = await createCaseFixture(t);
    const resolve = () =>
      t.db
        .updateTable('cases')
        .set({
          status: 'resolved',
          resolution_kind: 'action_taken',
          resolution_summary: 'Refunded the duplicate charge',
          resolved_at: t.clock.now(),
          resolved_by: ACTOR,
          revision: 2,
        })
        .where('id', '=', caseId)
        .execute();
    // A note is history only: it never counts as an action.
    await t.db
      .insertInto('case_events')
      .values({
        id: newId(),
        organization_id: t.organizationId,
        case_id: caseId,
        sequence: 2,
        kind: 'note',
        body: 'Refunded $20 by phone',
        from_status: null,
        to_status: null,
        case_action_id: null,
        details: json({}),
        actor: ACTOR,
        actor_person_id: null,
        occurred_at: t.clock.now(),
      })
      .execute();
    await expectPgError(resolve(), '23514');
    // A requested (not yet succeeded) helper action does not count either.
    await action(caseId, {
      status: 'requested',
      via: 'helper',
      support_operation_id: await operation(),
      request_key: `k-${newId()}`,
      completed_at: null,
    });
    await expectPgError(resolve(), '23514');
    await action(caseId, { command_operation_id: await operation() });
    await resolve();
    const row = await t.db
      .selectFrom('cases')
      .select(['status', 'resolution_kind'])
      .where('id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'resolved', resolution_kind: 'action_taken' });
  });

  it('SPK-SUPPORT-002: the database enforces the case lifecycle (created open, machine transitions, closed is final)', async () => {
    await expectPgError(
      t.db
        .insertInto('cases')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          facility_id: null,
          category: 'other',
          priority: 'normal',
          status: 'waiting_customer',
          title: 'Starts in the middle',
          description: null,
          subject_person_id: null,
          subject_household_id: null,
          owner_person_id: null,
          owner_queue: null,
          origin_access_review_id: null,
          origin_exception_id: null,
          due_at: null,
          resolution_kind: null,
          resolution_summary: null,
          resolved_at: null,
          resolved_by: null,
          closed_at: null,
          opened_by: ACTOR,
          opened_by_person_id: null,
        })
        .execute(),
      '23514',
    );
    const caseId = await createCaseFixture(t);
    // open → closed skips resolution.
    await expectPgError(
      t.db
        .updateTable('cases')
        .set({
          status: 'closed',
          closed_at: t.clock.now(),
          resolution_kind: 'duplicate',
          resolution_summary: 'dup',
          resolved_at: t.clock.now(),
          resolved_by: ACTOR,
          revision: 2,
        })
        .where('id', '=', caseId)
        .execute(),
      '23514',
    );
    // A change must bump the revision by exactly one.
    await expectPgError(
      t.db.updateTable('cases').set({ priority: 'high' }).where('id', '=', caseId).execute(),
      '23514',
    );
    await t.db
      .updateTable('cases')
      .set({
        status: 'resolved',
        resolution_kind: 'duplicate',
        resolution_summary: 'Duplicate of another case',
        resolved_at: t.clock.now(),
        resolved_by: ACTOR,
        revision: 2,
      })
      .where('id', '=', caseId)
      .execute();
    await t.db
      .updateTable('cases')
      .set({ status: 'closed', closed_at: t.clock.now(), revision: 3 })
      .where('id', '=', caseId)
      .execute();
    await expectPgError(
      t.db
        .updateTable('cases')
        .set({ title: 'Rewritten', revision: 4 })
        .where('id', '=', caseId)
        .execute(),
      '23514',
    );
    // A closed case accepts no new action.
    await expectPgError(action(caseId, { command_operation_id: await operation() }), '23514');
    // History is never deleted.
    await expectPgError(t.db.deleteFrom('cases').where('id', '=', caseId).execute(), '23001');
  });

  it('CaseMachine: the guard trigger accepts exactly the transitions the machine allows', async () => {
    type State = (typeof CaseMachine.states)[number];
    const columnsFor = (to: State) => ({
      status: to,
      resolution_kind: to === 'resolved' || to === 'closed' ? ('duplicate' as const) : null,
      resolution_summary: to === 'resolved' || to === 'closed' ? 'Duplicate' : null,
      resolved_at: to === 'resolved' || to === 'closed' ? t.clock.now() : null,
      resolved_by: to === 'resolved' || to === 'closed' ? ACTOR : null,
      closed_at: to === 'closed' ? t.clock.now() : null,
    });
    // A path from `open` to each source state through allowed transitions.
    const pathTo: Record<State, State[]> = {
      open: [],
      waiting_customer: ['waiting_customer'],
      waiting_internal: ['waiting_internal'],
      resolved: ['resolved'],
      closed: ['resolved', 'closed'],
    };
    const allowed = new Set<string>();
    for (const from of CaseMachine.states) {
      for (const event of CaseMachine.eventsFrom(from)) {
        allowed.add(`${from}->${CaseMachine.next(from, event as CaseEvent)}`);
      }
    }
    for (const from of CaseMachine.states) {
      for (const to of CaseMachine.states) {
        if (from === to) continue;
        const caseId = await createCaseFixture(t);
        let revision = 1;
        for (const step of pathTo[from]) {
          revision += 1;
          await t.db
            .updateTable('cases')
            .set({ ...columnsFor(step), revision })
            .where('id', '=', caseId)
            .execute();
        }
        const attempt = t.db
          .updateTable('cases')
          .set({ ...columnsFor(to), revision: revision + 1 })
          .where('id', '=', caseId)
          .execute();
        if (allowed.has(`${from}->${to}`)) {
          await attempt;
        } else {
          await expectPgError(attempt, '23514');
        }
      }
    }
  });

  it('case history and timeline references are append-only', async () => {
    const caseId = await createCaseFixture(t);
    await expectPgError(
      t.db.updateTable('case_events').set({ body: 'x' }).where('case_id', '=', caseId).execute(),
      '23001',
    );
    await expectPgError(
      t.db.deleteFrom('case_events').where('case_id', '=', caseId).execute(),
      '23001',
    );
    const personId = await createPersonFixture(t, { kind: 'adult' });
    const reference = {
      organization_id: t.organizationId,
      person_id: personId,
      record_type: 'payment_attempt' as const,
      record_id: newId(),
      relation: 'payer' as const,
      facility_id: null,
      occurred_at: t.clock.now(),
      source_event_id: newId(),
      source_event_type: 'finance.payment_received',
      summary: json({}),
    };
    await t.db
      .insertInto('timeline_references')
      .values({ id: newId(), ...reference })
      .execute();
    // A replayed event never indexes the same record for the same person twice.
    await expectPgError(
      t.db
        .insertInto('timeline_references')
        .values({ id: newId(), ...reference })
        .execute(),
      '23505',
    );
    await expectPgError(
      t.db
        .updateTable('timeline_references')
        .set({ relation: 'recipient' })
        .where('person_id', '=', personId)
        .execute(),
      '23001',
    );
  });

  it('§4.3: references never cross organizations (composite keys and kernel-reference triggers)', async () => {
    const foreignPerson = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    await expectPgError(createCaseFixture(t, { subjectPersonId: foreignPerson }), '23503');
    await expectPgError(createCaseFixture(t, { facilityId: other.facilityId }), '23503');
    const caseId = await createCaseFixture(t);
    // The kernel tables have no composite key: a trigger refuses another organization's operation.
    await expectPgError(
      action(caseId, { command_operation_id: await operation(other.organizationId) }),
      '23503',
    );
    const foreignCase = await createCaseFixture(t, { organizationId: other.organizationId });
    await expectPgError(action(foreignCase, { command_operation_id: await operation() }), '23503');
  });

  it('SPK-SUPPORT-003: a helper request runs once per case and key; one command outcome is linked once', async () => {
    const caseId = await createCaseFixture(t);
    const requestKey = `k-${newId()}`;
    await action(caseId, {
      status: 'requested',
      via: 'helper',
      support_operation_id: await operation(),
      request_key: requestKey,
      completed_at: null,
    });
    await expectPgError(
      action(caseId, {
        status: 'requested',
        via: 'helper',
        support_operation_id: await operation(),
        request_key: requestKey,
        completed_at: null,
      }),
      '23505',
    );
    const op = await operation();
    await action(caseId, { command_operation_id: op });
    await expectPgError(action(caseId, { command_operation_id: op }), '23505');
    // A linked action records a command that already ran: it cannot be pending.
    await expectPgError(
      action(caseId, {
        status: 'requested',
        command_operation_id: await operation(),
        completed_at: null,
      }),
      '23514',
    );
  });

  it('CaseActionMachine at the database: outcomes are final and the request is immutable', async () => {
    const caseId = await createCaseFixture(t);
    const { id } = await action(caseId, {
      status: 'requested',
      via: 'helper',
      support_operation_id: await operation(),
      request_key: `k-${newId()}`,
      completed_at: null,
    });
    await expectPgError(
      t.db
        .updateTable('case_actions')
        .set({ action_id: 'identity.revoke_access', revision: 2 })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
    await t.db
      .updateTable('case_actions')
      .set({
        status: 'failed',
        error: json({ code: 'ACCESS_DENIED', message: 'no' }),
        completed_at: t.clock.now(),
        revision: 2,
      })
      .where('id', '=', id)
      .execute();
    await expectPgError(
      t.db
        .updateTable('case_actions')
        .set({ status: 'succeeded', command_operation_id: await operation(), revision: 3 })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
    await expectPgError(t.db.deleteFrom('case_actions').where('id', '=', id).execute(), '23001');
  });

  it('SPK-UX-006: one live case per operational exception; a new one may open after it closed', async () => {
    const exception = await t.db.transaction().execute((trx) =>
      t.app.get(OperationalExceptions).raise(trx, {
        organizationId: t.organizationId,
        category: 'test.exception',
        severity: 'warning',
        title: 'Something needs an owner',
        ownerQueue: 'support_operator',
      }),
    );
    const insert = () =>
      t.db
        .insertInto('cases')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          facility_id: null,
          category: 'other',
          priority: 'normal',
          title: 'Coordinate the exception',
          description: null,
          subject_person_id: null,
          subject_household_id: null,
          owner_person_id: null,
          owner_queue: null,
          origin_access_review_id: null,
          origin_exception_id: exception.id,
          due_at: null,
          resolution_kind: null,
          resolution_summary: null,
          resolved_at: null,
          resolved_by: null,
          closed_at: null,
          opened_by: ACTOR,
          opened_by_person_id: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    const first = await insert();
    await expectPgError(insert(), '23505');
    await t.db
      .updateTable('cases')
      .set({
        status: 'resolved',
        resolution_kind: 'no_action_needed',
        resolution_summary: 'Handled',
        resolved_at: t.clock.now(),
        resolved_by: ACTOR,
        revision: 2,
      })
      .where('id', '=', first.id)
      .execute();
    await t.db
      .updateTable('cases')
      .set({ status: 'closed', closed_at: t.clock.now(), revision: 3 })
      .where('id', '=', first.id)
      .execute();
    await insert();
  });

  it('exception queues: owning roles are staff roles, names are unique, acknowledgment is due before resolution', async () => {
    await expectPgError(
      createExceptionQueueFixture(t, {
        name: 'bad_roles',
        owningRoles: ['captain' as never],
      }),
      '23514',
    );
    await createExceptionQueueFixture(t, { name: 'desk_follow_up', owningRoles: ['front_desk'] });
    await expectPgError(
      createExceptionQueueFixture(t, { name: 'desk_follow_up', owningRoles: ['front_desk'] }),
      '23505',
    );
    await expectPgError(
      createExceptionQueueFixture(t, {
        name: 'inverted_levels',
        owningRoles: ['front_desk'],
        acknowledgeWithinMinutes: 120,
        resolveWithinMinutes: 60,
      }),
      '23514',
    );
    // The same name in another organization is a different queue.
    await createExceptionQueueFixture(t, {
      name: 'desk_follow_up',
      owningRoles: ['front_desk'],
      organizationId: other.organizationId,
    });
  });
});
