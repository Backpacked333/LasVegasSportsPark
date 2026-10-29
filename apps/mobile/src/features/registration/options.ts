/**
 * Registration options of an offering (ENR-05; SPK-REG-001, SPK-REG-002, SPK-PLACE-001; SCR-C-08,
 * SCR-C-09, SCR-C-10): `GET /v1/offerings/{id}/registration-options` answers the intents the
 * offering accepts, the competition season an individual registrant's placement names, and, for
 * each named participant the account may register, the read-only eligibility of each intent.
 * Nothing is held or written by the read, and unknown evidence stays unknown.
 *
 * People the account may not register are left out of the answer, never reported: the screens
 * show them as "not available to register" without saying why (§4.10, SPK-IAM-003).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import type { RegistrationIntent } from './format';

export type RegistrationOptions = Schema<'RegistrationOptions'>;
export type EligibilityResult = NonNullable<Schema<'EligibilityResult'>>;
type EligibilityReason = Schema<'RegistrationEligibilityReason'>;

/** The API reads at most 20 participants per request (RegistrationOptionsQuery). */
export const OPTIONS_MAX_PARTICIPANTS = 20;

/** The reason code the evaluator gives for a required form that is not acknowledged yet. */
export const FORMS_REASON = 'acknowledgment_missing';

/**
 * `useRegistrationOptions(offeringId, personIds)`: one read per offering and sorted id set, so
 * the detail, the chooser and the placement form share it.
 */
export function useRegistrationOptions(
  offeringId: string,
  participantPersonIds: readonly string[] = [],
  enabled = true,
) {
  const { session } = useApp();
  const ids = [...new Set(participantPersonIds)].sort().slice(0, OPTIONS_MAX_PARTICIPANTS);
  return useApiQuery({
    path: '/offerings/{id}/registration-options',
    request: {
      path: { id: offeringId },
      query: ids.length > 0 ? { participantPersonIds: ids.join(',') } : {},
    },
    enabled: enabled && session.status === 'signed_in' && offeringId.length > 0,
  });
}

/** The eligibility the API answered for one participant and intent; null when it left them out. */
export function eligibilityOf(
  options: RegistrationOptions | undefined,
  personId: string,
  intent: RegistrationIntent,
): EligibilityResult | null {
  const participant = options?.participants.find((p) => p.personId === personId);
  const entry = participant?.intents.find((i) => i.intent === intent);
  return (entry?.eligibility as EligibilityResult | undefined) ?? null;
}

/** Whether the API named this participant at all (the account may register them). */
export function mayRegister(options: RegistrationOptions | undefined, personId: string): boolean {
  return options?.participants.some((p) => p.personId === personId) === true;
}

function reasonsOf(result: EligibilityResult, keep: (r: EligibilityReason) => boolean): string[] {
  return result.reasons.filter(keep).map((r) => r.message);
}

/** Reasons that stop the registration as entered (not forms, not information or unknowns). */
export function blockingEligibilityReasons(result: EligibilityResult): string[] {
  if (result.eligible || result.overridden) return [];
  return reasonsOf(result, (r) => r.severity === 'blocking' && r.code !== FORMS_REASON);
}

/**
 * SPK-REG-002 in the customer's words, never colour alone: "Eligible", "Eligible once the
 * required forms are signed", "Eligibility not known yet" (unknown evidence is not a pass) or
 * "Not eligible".
 */
export function eligibilityStatus(result: EligibilityResult): StatusBadgeProps {
  if (result.eligible || result.overridden) return { tone: 'success', label: 'Eligible' };
  if (blockingEligibilityReasons(result).length > 0) {
    return { tone: 'danger', label: 'Not eligible' };
  }
  if (result.reasons.some((r) => r.severity === 'unknown')) {
    return { tone: 'warning', label: 'Eligibility not known yet' };
  }
  if (result.reasons.some((r) => r.code === FORMS_REASON)) {
    return { tone: 'pending', label: 'Eligible once the required forms are signed' };
  }
  return { tone: 'danger', label: 'Not eligible' };
}

/** Every message the API gave with the result (reasons, then permitted alternatives). */
export function eligibilityMessages(result: EligibilityResult): {
  reasons: string[];
  alternatives: string[];
} {
  return {
    reasons: result.reasons.map((r) => r.message),
    alternatives: result.eligible ? [] : result.alternatives.map((a) => a.message),
  };
}
