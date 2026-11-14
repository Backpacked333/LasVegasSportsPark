import { Inject, Injectable } from '@nestjs/common';
import type { Trx } from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  POLICY_PORT,
  type OfferingLookupPort,
  type PolicyPort,
} from '../../catalog';
import type { ConditionFinding, FixtureConditionContext, FormsCheckPort } from '../../competition';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Required forms for fixture readiness (SPK-READY-001 "Required forms", SPK-READY-003),
 * registered as competition's FORMS_CHECK_IMPL. Enrollment joins the two sides: a season's
 * registration offering (`registrationOfferingRef`) names the catalog offering whose required
 * forms every rostered participant must have acknowledged (catalog OFFERING_LOOKUP_PORT and
 * POLICY_PORT; §4.2, no catalog table is read here). Reads go through the caller's transaction.
 *
 * - No registration offering: the season configures no forms, so nothing is required.
 * - An offering that cannot be resolved: `unknown`, never a pass (SPK-READY-002).
 * - A form some participant has not acknowledged: `unsatisfied` (blocking), with the count only, so
 *   readers do not learn which teammate has not signed (§4.14 minimized child information).
 * - A required waiver (SPK-REG-011, proposed) some participant has not accepted, or whose
 *   acceptance has lapsed: `unsatisfied` with the severity the approved waiver rule gives it
 *   (`warning` when it warns, `blocking` when it blocks), again with the count only.
 */
@Injectable()
export class CompetitionFormsCheck implements FormsCheckPort {
  constructor(
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(POLICY_PORT) private readonly policies: PolicyPort,
  ) {}

  async requiredForms(
    organizationId: string,
    context: FixtureConditionContext,
    trx?: Trx,
  ): Promise<ConditionFinding[]> {
    const ref = context.registrationOfferingRef ?? null;
    if (!ref) return [];
    const snapshot = UUID.test(ref)
      ? await this.offerings.getOffering(organizationId, ref, context.at, trx)
      : null;
    if (!snapshot) {
      return [
        {
          status: 'unknown',
          code: 'registration_offering_unresolved',
          message:
            'The season names a registration offering that cannot be found; its required forms cannot be confirmed.',
          source: { type: 'season', id: context.seasonId },
          responsibleRole: 'league_manager',
          requiredAction: "Correct the season's registration offering.",
          deadline: null,
        },
      ];
    }
    const findings: ConditionFinding[] = [];
    const persons = [...new Set(context.personIds)];
    for (const form of snapshot.requiredForms) {
      // R3-PERFORMANCE-01: one query per form for the whole roster, not one per person.
      const acknowledged = await this.policies.acknowledgedSubjects(
        organizationId,
        persons,
        form.id,
        trx,
      );
      const missing = persons.filter((personId) => !acknowledged.has(personId)).length;
      if (missing === 0) continue;
      findings.push({
        status: 'unsatisfied',
        code: 'required_form_missing',
        message: `${missing} rostered participant(s) have not acknowledged "${form.title}".`,
        source: { type: 'policy_version', id: form.id },
        responsibleRole: 'captain',
        requiredAction:
          'Ask the players (or their guardians) to complete the required form before the game.',
        deadline: null,
      });
    }
    // SPK-REG-011 (proposed amendment PA-01): the registration offering's required waivers, judged
    // for the whole roster by the catalog rule. Empty while liability waivers are turned off. A
    // rule that warns is reported as a warning; one that blocks (with no override recorded for
    // the fixture's season offering) blocks readiness. Counts only, as for forms (§4.14).
    const waivers =
      snapshot.requiredWaiverKeys.length > 0
        ? await this.policies.waiverFindings(
            organizationId,
            {
              personIds: persons,
              policyKeys: snapshot.requiredWaiverKeys,
              at: context.at,
              activities: [{ type: 'offering', id: snapshot.offering.id }],
            },
            trx,
          )
        : [];
    for (const policyKey of snapshot.requiredWaiverKeys) {
      const ofKey = waivers.filter((w) => w.policyKey === policyKey);
      for (const status of ['missing', 'lapsed'] as const) {
        const matching = ofKey.filter((w) => w.status === status);
        const first = matching[0];
        if (!first) continue;
        const blocking = matching.some((w) => w.severity === 'blocking');
        findings.push({
          status: 'unsatisfied',
          severity: blocking ? 'blocking' : 'warning',
          code: status === 'missing' ? 'waiver_missing' : 'waiver_lapsed',
          message:
            status === 'missing'
              ? `${matching.length} rostered participant(s) have not accepted "${first.title}".`
              : `The acceptance of "${first.title}" has lapsed for ${matching.length} rostered participant(s).`,
          source: { type: 'waiver', id: first.waiver.currentVersion?.policyVersionId ?? null },
          responsibleRole: 'captain',
          requiredAction:
            'Ask the players (or their guardians) to accept the waiver before the game.',
          deadline: null,
        });
      }
    }
    return findings;
  }
}
