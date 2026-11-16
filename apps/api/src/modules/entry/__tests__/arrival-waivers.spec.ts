import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createPolicyVersionFixture,
  fixtureWaiverContent,
  requireWaiverFixture,
} from '../../catalog';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import {
  enroll,
  entryTestApp,
  family,
  key,
  post,
  program,
  sessionRef,
  staffMember,
  type Actor,
  type Family,
  type Program,
} from './support';

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const waiverKey = () => `waiver-${newId().slice(-8)}`;

interface Issue {
  code: string;
  severity: string;
  message: string;
  nextAction: string;
  reference: { type: string; id: string } | null;
}

/**
 * The liability waiver at check-in (SPK-REG-011, proposed amendment PA-01; capability
 * `liability_waivers`, DEC-095). Each test approves its own waiver version; warn or block and the
 * renewal rule are that version's content.
 */
describe('arrival checks with required waivers (SPK-REG-011, proposed)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;

  const waiver = (
    policyKey: string,
    rule: Parameters<typeof fixtureWaiverContent>[0] = {},
    over: { version?: number; effectiveFrom?: Date } = {},
  ) =>
    createPolicyVersionFixture(t, {
      kind: 'waiver',
      key: policyKey,
      title: 'Liability waiver',
      version: over.version ?? 1,
      effectiveFrom: over.effectiveFrom ?? LONG_AGO,
      content: fixtureWaiverContent(rule),
    });
  const programRequiring = async (policyKey: string): Promise<Program> => {
    const p = await program(t, manager);
    await requireWaiverFixture(t, { offeringId: p.offering.offeringId, policyKey });
    return p;
  };
  /** A child with a confirmed enrollment, the ordinary form acknowledged, and a recorded arrival. */
  const participant = async (p: Program): Promise<string> => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: fam.guardian.personId,
      subjectPersonId: child,
    });
    await enroll(t, p, child, fam.guardian.personId);
    const arrival = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: child, visitorCategory: 'participant' }],
    });
    expect(arrival.status, JSON.stringify(arrival.body)).toBe(201);
    return child;
  };
  const checkIn = async (p: Program, personId: string) => {
    const res = await post(t, '/v1/session-checkins', desk, {
      personId,
      activity: sessionRef(p),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; status: string; revision: number; issues: Issue[] };
  };
  const waiverIssues = (body: { issues: Issue[] }) =>
    body.issues.filter((i) => i.code.startsWith('waiver_'));

  beforeAll(async () => {
    t = await entryTestApp();
    await t.enableCapability('liability_waivers');
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REG-011: check-in shows a missing waiver as a warning when the approved rule warns, and admits the participant', async () => {
    const policyKey = waiverKey();
    const version = await waiver(policyKey);
    const p = await programRequiring(policyKey);
    const child = await participant(p);
    const checkin = await checkIn(p, child);
    expect(checkin.status).toBe('admitted');
    expect(waiverIssues(checkin)).toEqual([
      {
        code: 'waiver_missing',
        severity: 'warning',
        message: '"Liability waiver" has not been accepted for this participant.',
        nextAction: 'accept_waiver',
        reference: { type: 'policy_version', id: version },
      },
    ]);
  });

  it('SPK-REG-011: check-in holds on a missing waiver when the approved rule blocks; accepting it, or a permitted recorded override, admits the participant', async () => {
    const policyKey = waiverKey();
    await waiver(policyKey, { enforcement: 'block', overrideRoles: ['program_manager'] });
    const p = await programRequiring(policyKey);

    // held, then admitted once the guardian's paper waiver is recorded at the desk
    const first = await participant(p);
    const held = await checkIn(p, first);
    expect(held.status).toBe('held');
    expect(waiverIssues(held)).toEqual([
      expect.objectContaining({ code: 'waiver_missing', severity: 'blocking' }),
    ]);
    const paper = await t.http
      .post('/v1/waiver-acceptances')
      .set(desk.header)
      .set('Idempotency-Key', key())
      .send({
        subjectPersonId: first,
        policyKey,
        method: 'paper',
        paperDatedOn: '2027-01-15',
        signedByPersonId: fam.guardian.personId,
      });
    expect(paper.status, JSON.stringify(paper.body)).toBe(201);
    const rechecked = await post(t, `/v1/session-checkins/${held.id}/recheck`, desk, {
      expectedRevision: held.revision,
    });
    expect(rechecked.status, JSON.stringify(rechecked.body)).toBe(200);
    expect(rechecked.body.status).toBe('admitted');
    expect(waiverIssues(rechecked.body)).toEqual([]);

    // held, then admitted with a recorded override for this session; the issue stays visible
    const second = await participant(p);
    const heldAgain = await checkIn(p, second);
    expect(heldAgain.status).toBe('held');
    const deskOverride = await t.http
      .post('/v1/waiver-overrides')
      .set(desk.header)
      .set('Idempotency-Key', key())
      .send({
        personId: second,
        policyKey,
        activity: { type: 'offering_session', id: p.sessionId },
        reason: 'Guardian is on the way with the form',
      });
    expect(deskOverride.status).toBe(403);
    const override = await t.http
      .post('/v1/waiver-overrides')
      .set(manager.header)
      .set('Idempotency-Key', key())
      .send({
        personId: second,
        policyKey,
        activity: { type: 'offering_session', id: p.sessionId },
        reason: 'Guardian is on the way with the form',
      });
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    const admitted = await post(t, `/v1/session-checkins/${heldAgain.id}/recheck`, desk, {
      expectedRevision: heldAgain.revision,
    });
    expect(admitted.body.status).toBe('admitted');
    expect(waiverIssues(admitted.body)).toEqual([
      expect.objectContaining({
        code: 'waiver_missing',
        severity: 'warning',
        message:
          '"Liability waiver" has not been accepted for this participant; staff recorded an override.',
      }),
    ]);
  });

  it('SPK-REG-011: check-in shows a lapsed waiver under both renewal rules, and nothing for a current one', async () => {
    // rule 1: the version in force requires re-acceptance of a new version
    const versionKey = waiverKey();
    const v1 = await waiver(versionKey);
    const v2 = await waiver(
      versionKey,
      { reacceptOnNewVersion: true },
      { version: 2, effectiveFrom: new Date('2027-01-01T00:00:00Z') },
    );
    const pA = await programRequiring(versionKey);
    const old = await participant(pA);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: old,
      policyVersionId: v1,
      signedByPersonId: fam.guardian.personId,
      signedAt: new Date('2026-09-01T00:00:00Z'),
    });
    expect(waiverIssues(await checkIn(pA, old))).toEqual([
      {
        code: 'waiver_lapsed',
        severity: 'warning',
        message: '"Liability waiver" has lapsed for this participant.',
        nextAction: 'accept_waiver',
        reference: { type: 'policy_version', id: v2 },
      },
    ]);
    const renewed = await participant(pA);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: renewed,
      policyVersionId: v2,
      signedByPersonId: fam.guardian.personId,
    });
    expect(waiverIssues(await checkIn(pA, renewed))).toEqual([]);

    // rule 2: periodic renewal that blocks
    const renewalKey = waiverKey();
    const renewal = await waiver(renewalKey, { renewEveryMonths: 12, enforcement: 'block' });
    const pB = await programRequiring(renewalKey);
    const expired = await participant(pB);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: expired,
      policyVersionId: renewal,
      signedByPersonId: fam.guardian.personId,
      signedAt: new Date('2026-01-10T00:00:00Z'),
    });
    const held = await checkIn(pB, expired);
    expect(held.status).toBe('held');
    expect(waiverIssues(held)).toEqual([
      expect.objectContaining({ code: 'waiver_lapsed', severity: 'blocking' }),
    ]);
    const inDate = await participant(pB);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: inDate,
      policyVersionId: renewal,
      signedByPersonId: fam.guardian.personId,
      signedAt: new Date('2026-06-10T00:00:00Z'),
    });
    const fine = await checkIn(pB, inDate);
    expect(fine.status).toBe('admitted');
    expect(waiverIssues(fine)).toEqual([]);
  });

  it('SPK-REG-011 with liability waivers turned off: check-in evaluates and shows nothing new', async () => {
    const policyKey = waiverKey();
    await waiver(policyKey, { enforcement: 'block' });
    const p = await programRequiring(policyKey);
    const child = await participant(p);
    await t.disableCapability('liability_waivers');
    try {
      const checkin = await checkIn(p, child);
      expect(checkin.status).toBe('admitted');
      expect(waiverIssues(checkin)).toEqual([]);
    } finally {
      await t.enableCapability('liability_waivers');
    }
  });
});
