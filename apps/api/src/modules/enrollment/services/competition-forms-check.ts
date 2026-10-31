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
    for (const form of snapshot.requiredForms) {
      let missing = 0;
      for (const personId of context.personIds) {
        if (!(await this.policies.hasAcknowledgment(organizationId, personId, form.id, trx))) {
          missing += 1;
        }
      }
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
    return findings;
  }
}
