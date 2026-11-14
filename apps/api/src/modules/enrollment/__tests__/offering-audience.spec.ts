import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { SESSION_AUDIENCE_PORT, type SessionAudiencePort } from '../../communications';
import { SessionParticipants } from '../services/session-participants';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import { adult, enrollmentTestApp, offering } from './support';

/**
 * `SessionAudiencePort.participantsOfOffering` (SPK-COMMS-009, proposed amendment PA-05): the
 * read communications addresses an offering's scheduled message with, when it is previewed and
 * again when it is sent. Enrollment implements it (SESSION_AUDIENCE_IMPL).
 */
describe('participants of an offering for its scheduled messages (SPK-COMMS-009)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await enrollmentTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-COMMS-009: answers the participants of live enrollments only, once each, and writes nothing', async () => {
    const camp = await offering(t, { kind: 'camp' });
    const other = await offering(t, { kind: 'camp' });
    const [confirmed, pending, canceled, elsewhere] = [
      await adult(t),
      await adult(t),
      await adult(t),
      await adult(t),
    ];
    await createEnrollmentFixture(t, {
      offeringId: camp.offeringId,
      participantPersonId: confirmed.personId,
    });
    await createEnrollmentFixture(t, {
      offeringId: camp.offeringId,
      participantPersonId: pending.personId,
      status: 'pending',
    });
    await createEnrollmentFixture(t, {
      offeringId: camp.offeringId,
      participantPersonId: canceled.personId,
      status: 'canceled',
    });
    await createEnrollmentFixture(t, {
      offeringId: other.offeringId,
      participantPersonId: elsewhere.personId,
    });
    const count = async () => (await t.db.selectFrom('enrollments').select('id').execute()).length;
    const before = await count();

    const participants = t.app.get(SessionParticipants);
    const expected = [confirmed.personId, pending.personId].sort();
    expect(
      await participants.participantsOfOffering(t.db, t.organizationId, camp.offeringId),
    ).toEqual(expected);
    // the port communications resolves lazily answers from the same implementation
    const port = t.app.get<SessionAudiencePort>(SESSION_AUDIENCE_PORT, { strict: false });
    expect(await port.participantsOfOffering(t.db, t.organizationId, camp.offeringId)).toEqual(
      expected,
    );
    expect(await port.participantsOfOffering(t.db, t.organizationId, other.offeringId)).toEqual([
      elsewhere.personId,
    ]);
    // an unknown offering, or another organization's view of this one, has nobody
    expect(await port.participantsOfOffering(t.db, t.organizationId, newId())).toEqual([]);
    expect(await port.participantsOfOffering(t.db, newId(), camp.offeringId)).toEqual([]);
    expect(await count()).toBe(before);
  });
});
