import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createPolicyVersionFixture,
  fixtureWaiverContent,
  requireWaiverFixture,
} from '../../catalog';
import { createPersonFixture } from '../../identity';
import { CompetitionFormsCheck } from '../services/competition-forms-check';
import {
  adult,
  child,
  enrollmentTestApp,
  key,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const waiverKey = () => `waiver-${newId().slice(-8)}`;

interface Reason {
  code: string;
  severity: string;
  message: string;
  source: { type: string; id: string | null };
  requiredAction: string;
}

/**
 * The liability waiver at registration and on rosters (SPK-REG-011, proposed amendment PA-01;
 * capability `liability_waivers`, DEC-095). Each test approves its own waiver version, so warn or
 * block, re-acceptance and renewal are that version's content and never a system constant.
 */
describe('registration and roster readiness with required waivers (SPK-REG-011, proposed)', () => {
  let t: TestApp;
  let parent: Actor;
  let manager: Actor;
  let forms: CompetitionFormsCheck;

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
  const offeringRequiring = async (policyKey: string): Promise<OfferingSetup> => {
    const setup = await offering(t);
    await requireWaiverFixture(t, { offeringId: setup.offeringId, policyKey });
    return setup;
  };
  const apply = async (setup: OfferingSetup, participant: string) => {
    const res = await post(t, '/v1/applications', parent.header, {
      offeringId: setup.offeringId,
      participantPersonId: participant,
      intent: 'youth',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as {
      status: string;
      eligibility: { eligible: boolean; reasons: Reason[]; alternatives: Array<{ kind: string }> };
    };
  };
  const waiverReasons = (body: { eligibility: { reasons: Reason[] } }) =>
    body.eligibility.reasons.filter((r) => r.code.startsWith('waiver_'));

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['pickup_sessions', 'liability_waivers'] });
    parent = await adult(t);
    manager = await staff(t, ['program_manager']);
    forms = t.app.get(CompetitionFormsCheck);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REG-011: registration shows a missing waiver as a warning when the approved rule warns, and the application is still accepted', async () => {
    const policyKey = waiverKey();
    const version = await waiver(policyKey, { enforcement: 'warn' });
    const setup = await offeringRequiring(policyKey);
    const kid = await child(t, [parent]);
    const body = await apply(setup, kid);
    expect(body.status).toBe('accepted');
    expect(body.eligibility.eligible).toBe(true);
    expect(waiverReasons(body)).toEqual([
      {
        code: 'waiver_missing',
        severity: 'warning',
        message:
          '"Liability waiver" has not been accepted for the participant; the participant or a guardian should accept it.',
        source: { type: 'waiver', id: version },
        requiredAction: 'accept_waiver',
      },
    ]);
    expect(body.eligibility.alternatives.map((a) => a.kind)).toContain('complete_acknowledgment');
  });

  it('SPK-REG-011: registration blocks on a missing waiver when the approved rule blocks, until it is accepted or a permitted override is recorded', async () => {
    const policyKey = waiverKey();
    const version = await waiver(policyKey, {
      enforcement: 'block',
      overrideRoles: ['program_manager'],
    });
    const setup = await offeringRequiring(policyKey);
    const blocked = await child(t, [parent]);
    const refused = await apply(setup, blocked);
    expect(refused.eligibility.eligible).toBe(false);
    expect(refused.status).toBe('submitted');
    expect(waiverReasons(refused)).toEqual([
      expect.objectContaining({
        code: 'waiver_missing',
        severity: 'blocking',
        requiredAction: 'accept_waiver',
      }),
    ]);

    // a recorded override for this offering turns the block into a warning
    const overridden = await child(t, [parent]);
    const override = await t.http
      .post('/v1/waiver-overrides')
      .set(manager.header)
      .set('Idempotency-Key', key())
      .send({
        personId: overridden,
        policyKey,
        activity: { type: 'offering', id: setup.offeringId },
        reason: 'Signed on paper, to be entered tomorrow',
      });
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    const allowed = await apply(setup, overridden);
    expect(allowed.eligibility.eligible).toBe(true);
    expect(waiverReasons(allowed)).toEqual([
      expect.objectContaining({ code: 'waiver_missing', severity: 'warning' }),
    ]);
    expect(waiverReasons(allowed)[0]?.message).toContain('staff recorded an override');

    // the guardian accepts for the third child: current, so nothing is shown
    const accepted = await child(t, [parent]);
    const acceptance = await t.http
      .post('/v1/waiver-acceptances')
      .set(parent.header)
      .set('Idempotency-Key', key())
      .send({ subjectPersonId: accepted, policyKey });
    expect(acceptance.status, JSON.stringify(acceptance.body)).toBe(201);
    expect(acceptance.body.policyVersionId).toBe(version);
    const current = await apply(setup, accepted);
    expect(current.eligibility.eligible).toBe(true);
    expect(waiverReasons(current)).toEqual([]);
  });

  it('SPK-REG-011: registration shows a lapsed waiver under both renewal rules (a new version that requires re-acceptance; periodic renewal)', async () => {
    // rule 1: the version in force requires re-acceptance
    const newVersionKey = waiverKey();
    const v1 = await waiver(newVersionKey);
    const first = await child(t, [parent]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: first,
      policyVersionId: v1,
      signedByPersonId: parent.personId,
      signedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const setupA = await offeringRequiring(newVersionKey);
    expect(waiverReasons(await apply(setupA, first))).toEqual([]);
    const v2 = await waiver(
      newVersionKey,
      { reacceptOnNewVersion: true, enforcement: 'block' },
      { version: 2, effectiveFrom: new Date('2026-10-01T00:00:00Z') },
    );
    const second = await child(t, [parent]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: second,
      policyVersionId: v1,
      signedByPersonId: parent.personId,
      signedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const lapsedByVersion = await apply(setupA, second);
    expect(lapsedByVersion.eligibility.eligible).toBe(false);
    expect(waiverReasons(lapsedByVersion)).toEqual([
      expect.objectContaining({
        code: 'waiver_lapsed',
        severity: 'blocking',
        source: { type: 'waiver', id: v2 },
      }),
    ]);

    // rule 2: periodic renewal; a paper acceptance counts from the date on the paper
    const renewalKey = waiverKey();
    const renewal = await waiver(renewalKey, { renewEveryMonths: 6 });
    const setupB = await offeringRequiring(renewalKey);
    const desk = await staff(t, ['front_desk']);
    const lapsedKid = await child(t, [parent]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: lapsedKid,
      policyVersionId: renewal,
      signedByPersonId: parent.personId,
      recordedByKind: 'staff',
      recordedByPersonId: desk.personId,
      method: 'paper',
      paperDatedOn: '2026-04-30',
    });
    const lapsedByTime = await apply(setupB, lapsedKid);
    expect(lapsedByTime.eligibility.eligible).toBe(true);
    expect(waiverReasons(lapsedByTime)).toEqual([
      expect.objectContaining({ code: 'waiver_lapsed', severity: 'warning' }),
    ]);
    expect(waiverReasons(lapsedByTime)[0]?.message).toContain('has lapsed');
    const currentKid = await child(t, [parent]);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: currentKid,
      policyVersionId: renewal,
      signedByPersonId: parent.personId,
      recordedByKind: 'staff',
      recordedByPersonId: desk.personId,
      method: 'paper',
      paperDatedOn: '2026-06-30',
    });
    expect(waiverReasons(await apply(setupB, currentKid))).toEqual([]);
  });

  it('SPK-REG-011: roster readiness counts rostered participants whose waiver is missing or lapsed, as a warning or a block by the approved rule, and reports nothing for a current one', async () => {
    const warnKey = waiverKey();
    const blockKey = waiverKey();
    const warnVersion = await waiver(warnKey, { renewEveryMonths: 6 });
    const blockVersion = await waiver(blockKey, { enforcement: 'block' });
    const setup = await offering(t);
    await requireWaiverFixture(t, { offeringId: setup.offeringId, policyKey: warnKey });
    await requireWaiverFixture(t, { offeringId: setup.offeringId, policyKey: blockKey });
    const [current, lapsed, missing] = await Promise.all(
      [1, 2, 3].map(() => createPersonFixture(t, { kind: 'adult' })),
    );
    if (!current || !lapsed || !missing) throw new Error('fixture people were not created');
    for (const person of [current, lapsed, missing]) {
      // every rostered player acknowledged the offering's ordinary form
      await createAcknowledgmentFixture(t, {
        subjectPersonId: person,
        policyVersionId: setup.formPolicyVersionId,
        signedByPersonId: person,
      });
    }
    for (const version of [warnVersion, blockVersion]) {
      await createAcknowledgmentFixture(t, {
        subjectPersonId: current,
        policyVersionId: version,
        signedByPersonId: current,
      });
    }
    await createAcknowledgmentFixture(t, {
      subjectPersonId: lapsed,
      policyVersionId: warnVersion,
      signedByPersonId: lapsed,
      signedAt: new Date('2026-03-01T00:00:00Z'),
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: lapsed,
      policyVersionId: blockVersion,
      signedByPersonId: lapsed,
    });
    const context = {
      fixtureId: newId(),
      seasonId: newId(),
      teamEntryIds: [],
      personIds: [current, lapsed, missing],
      at: t.clock.now(),
      registrationOfferingRef: setup.offeringId,
    };
    const findings = await forms.requiredForms(t.organizationId, context);
    expect(
      findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    ).toEqual([
      {
        code: 'waiver_missing',
        severity: 'warning',
        message: '1 rostered participant(s) have not accepted "Liability waiver".',
      },
      {
        code: 'waiver_lapsed',
        severity: 'warning',
        message: 'The acceptance of "Liability waiver" has lapsed for 1 rostered participant(s).',
      },
      {
        code: 'waiver_missing',
        severity: 'blocking',
        message: '1 rostered participant(s) have not accepted "Liability waiver".',
      },
    ]);
    expect(findings.every((f) => f.status === 'unsatisfied')).toBe(true);
    // a roster on which every waiver is current reports nothing
    expect(
      await forms.requiredForms(t.organizationId, { ...context, personIds: [current] }),
    ).toEqual([]);
  });

  it('SPK-REG-011 with liability waivers turned off: registration and roster readiness evaluate and show nothing new', async () => {
    const policyKey = waiverKey();
    await waiver(policyKey, { enforcement: 'block' });
    const setup = await offeringRequiring(policyKey);
    const kid = await child(t, [parent]);
    const player = await createPersonFixture(t, { kind: 'adult' });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: player,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: player,
    });
    await t.disableCapability('liability_waivers');
    try {
      const body = await apply(setup, kid);
      expect(body.status).toBe('accepted');
      expect(body.eligibility.eligible).toBe(true);
      // today's behaviour, unchanged: the outstanding form is the only reason, as a warning
      expect(body.eligibility.reasons).toEqual([
        expect.objectContaining({
          code: 'acknowledgment_missing',
          severity: 'warning',
          source: { type: 'policy_version', id: setup.formPolicyVersionId },
        }),
      ]);
      expect(
        await forms.requiredForms(t.organizationId, {
          fixtureId: newId(),
          seasonId: newId(),
          teamEntryIds: [],
          personIds: [player],
          at: t.clock.now(),
          registrationOfferingRef: setup.offeringId,
        }),
      ).toEqual([]);
    } finally {
      await t.enableCapability('liability_waivers');
    }
    // with the capability back on the same registration is blocked
    const again = await apply(setup, await child(t, [parent]));
    expect(again.eligibility.eligible).toBe(false);
  });
});
