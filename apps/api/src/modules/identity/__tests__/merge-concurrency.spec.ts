import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditWriter, OperationsService } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing/test-app';
import { IdentityModule } from '../identity.module';
import { DuplicatesService } from '../services/duplicates.service';
import {
  authHeaderForPerson,
  createAccountFixture,
  createPersonFixture,
  createRelationshipFixture,
  createStaffMemberFixture,
} from '../testing/identity-fixtures';
import { backendPid, gate, tracked, untilSettledOrBlockedBy } from './support';

const key = () => `k-${newId()}`;

/**
 * A person merge racing the commands that touch what it moves (§4.9, SPK-IAM-006, SPK-IAM-007).
 * Each case holds one transaction open at a chosen point (a gate inside it) while the other
 * command runs. Under PGlite transactions serialize, so the other command runs after the gate
 * opens; under TEST_DATABASE_URL it must wait for the paused transaction's row locks (detected with
 * pg_blocking_pids), and the assertions on the committed rows hold in both modes.
 */
describe('person merge under concurrency (§4.9, SPK-IAM-006, SPK-IAM-007)', () => {
  let t: TestApp;
  let adminHeader: Record<string, string>;
  let adminPersonId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    const admin = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    adminPersonId = admin.personId;
    adminHeader = await authHeaderForPerson(t, admin.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  async function flag(personAId: string, personBId: string): Promise<string> {
    const flagged = await t.http
      .post('/v1/duplicate-candidates')
      .set(adminHeader)
      .set('Idempotency-Key', key())
      .send({ personAId, personBId, reasons: ['desk'] });
    expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
    return flagged.body.id as string;
  }

  const merge = (candidateId: string, survivorPersonId: string) =>
    t.http
      .post(`/v1/duplicate-candidates/${candidateId}/merge`)
      .set(adminHeader)
      .set('Idempotency-Key', key())
      .send({ survivorPersonId, reason: 'same person' });

  /** A guardian holding staff-source `view` over two child records of the same child. */
  async function guardianOverPair() {
    const guardian = await createPersonFixture(t, { kind: 'adult' });
    await createAccountFixture(t, { personId: guardian });
    const survivor = await createPersonFixture(t, { kind: 'child' });
    const duplicate = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: guardian,
      subjectPersonId: survivor,
      permissions: ['view'],
    });
    const overDuplicate = await createRelationshipFixture(t, {
      actorPersonId: guardian,
      subjectPersonId: duplicate,
      permissions: ['view'],
    });
    return {
      guardian,
      guardianHeader: await authHeaderForPerson(t, guardian),
      survivor,
      duplicate,
      relationshipId: overDuplicate.relationshipId,
      grantId: overDuplicate.grantIds.view as string,
      candidateId: await flag(survivor, duplicate),
    };
  }

  const grantFacts = async (grantId: string) => ({
    row: await t.db
      .selectFrom('access_grants')
      .select(['revision', 'revocation_reason', 'revoked_by'])
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow(),
    events: await t.db
      .selectFrom('outbox_events')
      .select('operation_id')
      .where('aggregate_id', '=', grantId)
      .where('event_type', '=', 'identity.access_grant_revoked')
      .execute(),
    audits: await t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision', 'operation_id'])
      .where('target_id', '=', grantId)
      .execute(),
  });

  it('§4.9 / SPK-IAM-006: a holder revoking, or staff granting on, what a running merge has locked waits for it; the merge’s revocation stands, audited and announced once (PGlite and TEST_DATABASE_URL)', async () => {
    const pair = await guardianOverPair();
    // Pause the merge inside its first grant revocation: it holds the duplicate's relationship and
    // grant rows (read FOR UPDATE) and has not written them yet.
    const service = t.app.get(DuplicatesService) as unknown as {
      revokeGrant: (...args: unknown[]) => Promise<void>;
    };
    const revokeGrant = service.revokeGrant.bind(service);
    const paused = gate();
    let holder: number | undefined;
    let gated = false;
    const spy = vi.spyOn(service, 'revokeGrant').mockImplementation(async (...args: unknown[]) => {
      if (!gated) {
        gated = true;
        if (t.database.concurrent) holder = await backendPid(args[0] as never);
        await paused.pass();
      }
      return revokeGrant(...args);
    });
    let results: { status: number; body: Record<string, unknown> }[];
    try {
      const merging = tracked(merge(pair.candidateId, pair.survivor));
      await paused.reached;
      const revoking = tracked(
        t.http
          .post(`/v1/access-grants/${pair.grantId}/revoke`)
          .set(pair.guardianHeader)
          .set('Idempotency-Key', key())
          .send({ reason: 'I give this up' }),
      );
      if (t.database.concurrent) {
        expect(await untilSettledOrBlockedBy(t, revoking, () => holder, 1)).toBe(true);
      }
      const granting = tracked(
        t.http
          .post('/v1/access-grants')
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({ relationshipId: pair.relationshipId, permission: 'collect' }),
      );
      if (t.database.concurrent) {
        expect(await untilSettledOrBlockedBy(t, granting, () => holder, 2)).toBe(true);
      }
      paused.open();
      results = await Promise.all([merging.promise, revoking.promise, granting.promise]);
    } finally {
      paused.open();
      spy.mockRestore();
    }
    const [merged, revoked, granted] = results;
    expect(merged?.status, JSON.stringify(merged?.body)).toBe(201);
    expect(merged?.body.moved).toMatchObject({
      grantsRevokedAsDuplicate: 1,
      relationshipsConsolidated: 1,
    });
    // the holder's revoke and the grant follow the committed merge: already revoked, and ended
    expect(revoked?.status, JSON.stringify(revoked?.body)).toBe(409);
    expect(revoked?.body.code).toBe('INVALID_TRANSITION');
    expect(granted?.status, JSON.stringify(granted?.body)).toBe(409);
    expect(granted?.body.code).toBe('INVALID_TRANSITION');
    const operationId = merged?.body.operationId as string;
    const facts = await grantFacts(pair.grantId);
    expect(facts.row).toMatchObject({
      revision: 2,
      revocation_reason: 'merge: equivalent grant already held by the survivor',
      revoked_by: { personId: adminPersonId },
    });
    expect(facts.events).toEqual([{ operation_id: operationId }]);
    expect(facts.audits).toEqual([
      {
        action: 'identity.revoke_access',
        before_revision: 1,
        after_revision: 2,
        operation_id: operationId,
      },
    ]);
    const live = await t.db
      .selectFrom('access_grants')
      .select('id')
      .where('relationship_id', '=', pair.relationshipId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toEqual([]);
  });

  it('§4.9 / SPK-IAM-006: a merge reaching a grant its holder is revoking waits, then leaves the holder’s revocation as it is (PGlite and TEST_DATABASE_URL)', async () => {
    const pair = await guardianOverPair();
    // Pause the holder's revoke at its audit record: it holds the grant row and has revoked it.
    const audit = t.app.get(AuditWriter);
    const record = audit.record.bind(audit);
    const paused = gate();
    let holder: number | undefined;
    let gated = false;
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (trx, input) => {
      if (!gated && input.targetId === pair.grantId) {
        gated = true;
        if (t.database.concurrent) holder = await backendPid(trx);
        await paused.pass();
      }
      return record(trx, input);
    });
    let results: { status: number; body: Record<string, unknown> }[];
    try {
      const revoking = tracked(
        t.http
          .post(`/v1/access-grants/${pair.grantId}/revoke`)
          .set(pair.guardianHeader)
          .set('Idempotency-Key', key())
          .send({ reason: 'I give this up' }),
      );
      await paused.reached;
      const merging = tracked(merge(pair.candidateId, pair.survivor));
      // PostgreSQL: the merge waits for the grant row before reading it for a write.
      if (t.database.concurrent) {
        expect(await untilSettledOrBlockedBy(t, merging, () => holder)).toBe(true);
      }
      paused.open();
      results = await Promise.all([revoking.promise, merging.promise]);
    } finally {
      paused.open();
      spy.mockRestore();
    }
    const [revoked, merged] = results;
    expect(revoked?.status, JSON.stringify(revoked?.body)).toBe(200);
    expect(merged?.status, JSON.stringify(merged?.body)).toBe(201);
    // the revoked grant is no longer live, so the merge has nothing of it to revoke
    expect(merged?.body.moved).toMatchObject({
      grantsRevokedAsDuplicate: 0,
      relationshipsConsolidated: 1,
    });
    const facts = await grantFacts(pair.grantId);
    expect(facts.row).toMatchObject({
      revision: 2,
      revocation_reason: 'I give this up',
      revoked_by: { personId: pair.guardian },
    });
    expect(facts.events).toEqual([{ operation_id: null }]);
    expect(facts.audits).toEqual([
      {
        action: 'identity.revoke_access',
        before_revision: 1,
        after_revision: 2,
        operation_id: null,
      },
    ]);
  });

  interface PersonScopedCreate {
    name: string;
    send: (duplicate: string) => Promise<{ status: number; body: Record<string, unknown> }>;
    code: string;
  }

  const creates: PersonScopedCreate[] = [
    {
      name: 'POST /accounts with personId',
      send: async (duplicate) =>
        t.http
          .post('/v1/accounts')
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({
            issuer: t.config.AUTH_ISSUER,
            subject: `new-${newId()}`,
            personId: duplicate,
            reason: 'desk',
          }),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'POST /staff-memberships',
      send: async (duplicate) =>
        t.http
          .post('/v1/staff-memberships')
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({ personId: duplicate, roles: ['coach'] }),
      code: 'VALIDATION_FAILED',
    },
    {
      name: 'POST /households/{id}/members',
      send: async (duplicate) => {
        const household = await t.http
          .post('/v1/households')
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({ name: `Household ${newId()}` });
        expect(household.status, JSON.stringify(household.body)).toBe(201);
        return t.http
          .post(`/v1/households/${household.body.id}/members`)
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({ personId: duplicate });
      },
      code: 'NOT_FOUND',
    },
    {
      name: 'POST /relationships',
      send: async (duplicate) =>
        t.http
          .post('/v1/relationships')
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({
            actorPersonId: await createPersonFixture(t, { kind: 'adult' }),
            subjectPersonId: duplicate,
            kind: 'caregiver',
            permissions: ['view'],
          }),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'POST /people/{id}/claims',
      send: async (duplicate) =>
        t.http
          .post(`/v1/people/${duplicate}/claims`)
          .set(adminHeader)
          .set('Idempotency-Key', key())
          .send({
            kind: 'guardian',
            requestedPermissions: ['view'],
            recipientContact: { kind: 'email', value: `claim-${newId()}@example.test` },
          }),
      code: 'INVALID_TRANSITION',
    },
  ];

  it.each(creates)(
    '§4.9 / SPK-IAM-007: $name for the merged person while the merge holds both persons waits for the merge and is then refused; nothing is attached to the merged record (PGlite and TEST_DATABASE_URL)',
    async ({ send, code }) => {
      const survivor = await createPersonFixture(t, { kind: 'adult' });
      const duplicate = await createPersonFixture(t, { kind: 'adult' });
      const candidateId = await flag(survivor, duplicate);
      // Pause the merge right after it has locked the candidate and both persons.
      const operations = t.app.get(OperationsService);
      const create = operations.create.bind(operations);
      const paused = gate();
      let holder: number | undefined;
      const spy = vi.spyOn(operations, 'create').mockImplementation(async (trx, input) => {
        if (input.kind === 'identity.merge_persons') {
          if (t.database.concurrent) holder = await backendPid(trx);
          await paused.pass();
        }
        return create(trx, input);
      });
      let results: { status: number; body: Record<string, unknown> }[];
      try {
        const merging = tracked(merge(candidateId, survivor));
        await paused.reached;
        const attaching = tracked(send(duplicate));
        if (t.database.concurrent) {
          expect(await untilSettledOrBlockedBy(t, attaching, () => holder)).toBe(true);
        }
        paused.open();
        results = await Promise.all([merging.promise, attaching.promise]);
      } finally {
        paused.open();
        spy.mockRestore();
      }
      const [merged, attached] = results;
      expect(merged?.status, JSON.stringify(merged?.body)).toBe(201);
      expect(attached?.body.code, JSON.stringify(attached?.body)).toBe(code);
      const count = async (table: 'accounts' | 'staff_memberships' | 'household_memberships') =>
        (await t.db.selectFrom(table).select('id').where('person_id', '=', duplicate).execute())
          .length;
      expect(await count('accounts')).toBe(0);
      expect(await count('staff_memberships')).toBe(0);
      expect(await count('household_memberships')).toBe(0);
      const relationships = await t.db
        .selectFrom('relationships')
        .select('id')
        .where('subject_person_id', '=', duplicate)
        .execute();
      expect(relationships).toEqual([]);
      const claims = await t.db
        .selectFrom('claims')
        .select('id')
        .where('subject_person_id', '=', duplicate)
        .execute();
      expect(claims).toEqual([]);
    },
  );
});
