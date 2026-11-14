import { describe, expect, it, vi } from 'vitest';
import type { OfferingLookupPort, PolicyPort } from '../../catalog';
import { CompetitionFormsCheck } from './competition-forms-check';

const OFFERING = '0192f1a0-0000-7000-8000-0000000000f1';
const FORM_A = '0192f1a0-0000-7000-8000-0000000000a1';
const FORM_B = '0192f1a0-0000-7000-8000-0000000000b1';

/**
 * R3-PERFORMANCE-01 (§5.9, SPK-READY-001 "Required forms"): the forms check of a fixture's
 * readiness reads each required form's acknowledgments for the whole roster in one call, not one
 * per rostered person, and still reports only the count of participants missing it.
 */
describe('CompetitionFormsCheck (R3-PERFORMANCE-01)', () => {
  it('SPK-READY-001: one acknowledgment read per form for the roster; counts the missing participants', async () => {
    const offerings = {
      getOffering: vi.fn(async () => ({
        requiredForms: [
          { id: FORM_A, title: 'Waiver' },
          { id: FORM_B, title: 'Code of conduct' },
        ],
        requiredWaiverKeys: [],
      })),
    } as unknown as OfferingLookupPort;
    const acknowledgedSubjects = vi.fn(
      async (_org: string, _people: readonly string[], form: string) =>
        form === FORM_A ? new Set(['p1', 'p2', 'p3']) : new Set(['p1']),
    );
    const hasAcknowledgment = vi.fn();
    const policies = { acknowledgedSubjects, hasAcknowledgment } as unknown as PolicyPort;
    const check = new CompetitionFormsCheck(offerings, policies);
    const findings = await check.requiredForms('org', {
      fixtureId: 'f1',
      seasonId: 's1',
      teamEntryIds: [],
      personIds: ['p1', 'p2', 'p3', 'p2'],
      at: new Date('2026-11-02T15:00:00Z'),
      registrationOfferingRef: OFFERING,
    });
    expect(acknowledgedSubjects).toHaveBeenCalledTimes(2);
    expect(acknowledgedSubjects).toHaveBeenCalledWith('org', ['p1', 'p2', 'p3'], FORM_A, undefined);
    expect(hasAcknowledgment).not.toHaveBeenCalled();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      status: 'unsatisfied',
      code: 'required_form_missing',
      message: '2 rostered participant(s) have not acknowledged "Code of conduct".',
      source: { type: 'policy_version', id: FORM_B },
    });
  });

  it('SPK-REG-011: required waivers are asked of the catalog once for the roster; a block anywhere in a group blocks, otherwise it warns', async () => {
    const offerings = {
      getOffering: vi.fn(async () => ({
        offering: { id: OFFERING },
        requiredForms: [],
        requiredWaiverKeys: ['liability'],
      })),
    } as unknown as OfferingLookupPort;
    const finding = (personId: string, status: string, severity: string) => ({
      personId,
      policyKey: 'liability',
      title: 'Liability waiver',
      status,
      severity,
      override: null,
      waiver: { currentVersion: { policyVersionId: FORM_A } },
    });
    const waiverFindings = vi.fn(async () => [
      finding('p1', 'missing', 'blocking'),
      finding('p2', 'missing', 'warning'),
      finding('p3', 'lapsed', 'warning'),
    ]);
    const policies = { waiverFindings } as unknown as PolicyPort;
    const at = new Date('2026-11-02T15:00:00Z');
    const findings = await new CompetitionFormsCheck(offerings, policies).requiredForms('org', {
      fixtureId: 'f1',
      seasonId: 's1',
      teamEntryIds: [],
      personIds: ['p1', 'p2', 'p3', 'p4'],
      at,
      registrationOfferingRef: OFFERING,
    });
    expect(waiverFindings).toHaveBeenCalledTimes(1);
    expect(waiverFindings).toHaveBeenCalledWith(
      'org',
      {
        personIds: ['p1', 'p2', 'p3', 'p4'],
        policyKeys: ['liability'],
        at,
        activities: [{ type: 'offering', id: OFFERING }],
      },
      undefined,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        status: 'unsatisfied',
        severity: 'blocking',
        code: 'waiver_missing',
        message: '2 rostered participant(s) have not accepted "Liability waiver".',
        source: { type: 'waiver', id: FORM_A },
      }),
      expect.objectContaining({
        status: 'unsatisfied',
        severity: 'warning',
        code: 'waiver_lapsed',
        message: 'The acceptance of "Liability waiver" has lapsed for 1 rostered participant(s).',
      }),
    ]);
  });
});
