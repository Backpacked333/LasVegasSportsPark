import { systemPrincipal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecoveryMode } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import {
  createContactPointFixture,
  createOrganizationPeople,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import {
  attemptsOf,
  composeAndDispatch,
  deliverQueued,
  fakeProviders,
  type FakeProviders,
} from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

/**
 * R3-OPERATIONS-05 (§5.8 "restoring an older database cannot undo" what providers did, SPK-AT-028;
 * recovery runbook §5.2 and §7 step 9): while an organization recovers from a restore, the
 * delivery worker hands none of its queued attempts to a messaging provider; they wait, unclaimed,
 * and are sent after the general manager resumes. Other organizations are not held back.
 */
describe('message delivery pauses during recovery (R3-OPERATIONS-05, SPK-AT-028)', () => {
  let t: TestApp;
  let org: string;
  let people: OrganizationPeople;
  let fakes: FakeProviders;

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    fakes = fakeProviders(t.app);
    people = await createOrganizationPeople(t);
    await createContactPointFixture(t, {
      personId: people.adult.personId,
      kind: 'email',
      value: 'parent@example.test',
      verified: true,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.8: a queued attempt of an organization in recovery is not sent, and is sent after resume', async () => {
    const notice = await composeAndDispatch(t.app, systemPrincipal(org, 'test'), {
      kind: 'placement' as const,
      audience: { subjectPersonIds: [people.child.personId] },
      title: 'Placement confirmed',
      body: 'Your child has been placed on the Lions.',
    });
    expect(notice.status).toBe('dispatched');
    // another organization in recovery does not hold this one back, and vice versa
    const other = await seedOrganization(t.db);
    const recovery = t.app.get(RecoveryMode);
    expect(await recovery.enterAll('restore-delivery')).toBe(2);
    expect(await recovery.isActive(other.organizationId)).toBe(true);

    fakes.email.reset();
    const paused = await deliverQueued(t.app);
    expect(paused.claimed).toBe(0);
    expect(fakes.email.sent).toHaveLength(0);
    const queued = (await attemptsOf(t.db, org, notice.id)).find((a) => a.channel === 'email');
    expect(queued).toMatchObject({ status: 'queued' });

    await recovery.resume(
      staffPrincipal(org, ['general_manager']),
      { reason: 'messages reviewed' },
      null,
    );
    const sent = await deliverQueued(t.app);
    expect(sent.claimed).toBeGreaterThanOrEqual(1);
    expect(fakes.email.sent).toHaveLength(1);
    expect(fakes.email.sent[0]).toMatchObject({ address: 'parent@example.test' });
  });
});
