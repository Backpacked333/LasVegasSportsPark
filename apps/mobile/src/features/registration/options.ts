/**
 * Registration options of an offering (ENR-05; SPK-REG-001, SPK-REG-002, SPK-PLACE-001; SCR-C-08,
 * SCR-C-09, SCR-C-10): `GET /v1/offerings/{id}/registration-options` answers the intents the
 * offering accepts, the competition season an individual registrant's placement names, and, for
 * each named participant the account may register, the read-only eligibility of each intent.
 * Nothing is held or written by the read, and unknown evidence stays unknown.
 *
 * People the account may not register are left out of the answer, never reported: the screens
 * show them as "not available to register" without saying why (§4.10, SPK-IAM-003). The API reads
 * at most 20 people per request, so a larger household is read in several requests whose answers
 * are merged; nobody is left unasked.
 */
import { apiQueryKey, type ApiError, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useApi, useApp } from '../../providers/AppProviders';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import type { RegistrationIntent } from './format';

export type RegistrationOptions = Schema<'RegistrationOptions'>;
export type EligibilityResult = NonNullable<Schema<'EligibilityResult'>>;
type EligibilityReason = Schema<'RegistrationEligibilityReason'>;

/** The API reads at most 20 participants per request (RegistrationOptionsQuery). */
export const OPTIONS_MAX_PARTICIPANTS = 20;

/** The reason code the evaluator gives for a required form that is not acknowledged yet. */
export const FORMS_REASON = 'acknowledgment_missing';

const OPTIONS_PATH = '/offerings/{id}/registration-options';

/** Sorted, deduplicated ids in groups the API accepts; one empty group when nobody is named. */
export function optionsChunks(participantPersonIds: readonly string[]): string[][] {
  const ids = [...new Set(participantPersonIds)].sort();
  if (ids.length === 0) return [[]];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += OPTIONS_MAX_PARTICIPANTS) {
    out.push(ids.slice(i, i + OPTIONS_MAX_PARTICIPANTS));
  }
  return out;
}

/** The SPK-UX-008 view of the (possibly several) reads behind one set of options. */
export interface RegistrationOptionsState {
  /** Every group's answer merged; undefined until all of them have answered. */
  data: RegistrationOptions | undefined;
  /** The first failure of a group that has no answer yet. */
  error: ApiError | null;
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  /** Reads every group again (the "Try again" and "Reload" of the screens). */
  refetch: () => Promise<unknown>;
}

interface GroupResult {
  data: ApiResponse<RegistrationOptions> | undefined;
  error: ApiError | null;
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => Promise<unknown>;
}

/** Merges the groups' answers: the offering's intents and season once, every named participant. */
export function mergeOptions(answers: readonly RegistrationOptions[]): RegistrationOptions {
  const [first, ...rest] = answers as [RegistrationOptions, ...RegistrationOptions[]];
  return {
    ...first,
    participants: [first, ...rest].flatMap((answer) => answer.participants),
  };
}

/**
 * `useRegistrationOptions(offeringId, personIds)`: one read per offering and group of sorted ids
 * (the same cache key as `useApiQuery` for that request), so the detail, the chooser and the
 * placement form share it.
 */
export function useRegistrationOptions(
  offeringId: string,
  participantPersonIds: readonly string[] = [],
  enabled = true,
): RegistrationOptionsState {
  const api = useApi();
  const { session } = useApp();
  const key = optionsChunks(participantPersonIds)
    .map((group) => group.join(','))
    .join('|');
  const groups = useMemo(() => key.split('|'), [key]);
  const combine = useCallback((results: readonly GroupResult[]): RegistrationOptionsState => {
    const answers = results.map((r) => r.data?.data);
    const complete = answers.every((a): a is RegistrationOptions => a !== undefined);
    const failed = results.find((r) => r.data === undefined && r.error);
    return {
      data: complete && answers.length > 0 ? mergeOptions(answers) : undefined,
      error: failed?.error ?? null,
      isPending: results.some((r) => r.isPending),
      fetchStatus: results.some((r) => r.fetchStatus === 'fetching')
        ? 'fetching'
        : results.some((r) => r.fetchStatus === 'paused')
          ? 'paused'
          : 'idle',
      refetch: () => Promise.all(results.map((r) => r.refetch())),
    };
  }, []);
  return useQueries({
    queries: groups.map((group) => {
      const request = {
        path: { id: offeringId },
        query: group ? { participantPersonIds: group } : {},
      };
      return {
        queryKey: apiQueryKey(OPTIONS_PATH, request),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          (
            api.request as (
              method: 'get',
              path: string,
              options: object,
            ) => Promise<ApiResponse<RegistrationOptions>>
          )('get', OPTIONS_PATH, { ...request, signal }),
        enabled: enabled && session.status === 'signed_in' && offeringId.length > 0,
      };
    }),
    combine: combine as unknown as (
      results: readonly { data: unknown; error: unknown }[],
    ) => RegistrationOptionsState,
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

/** Whether a required form is still to be acknowledged (the evaluator's `warning`). */
function formsOutstanding(result: EligibilityResult): boolean {
  return result.reasons.some((r) => r.code === FORMS_REASON);
}

/**
 * SPK-REG-002 in the customer's words, never colour alone: "Eligible", "Eligible once the
 * required forms are signed", "Eligibility not known yet" (unknown evidence is not a pass) or
 * "Not eligible". The API sends an outstanding form as a `warning` and leaves `eligible: true`
 * (forms are signed before the hold, SPK-REG-009), so forms are checked before the plain pass.
 */
export function eligibilityStatus(result: EligibilityResult): StatusBadgeProps {
  if (!result.overridden) {
    if (blockingEligibilityReasons(result).length > 0) {
      return { tone: 'danger', label: 'Not eligible' };
    }
    if (result.reasons.some((r) => r.severity === 'unknown')) {
      return { tone: 'warning', label: 'Eligibility not known yet' };
    }
  }
  if (formsOutstanding(result)) {
    return { tone: 'pending', label: 'Eligible once the required forms are signed' };
  }
  if (result.eligible || result.overridden) return { tone: 'success', label: 'Eligible' };
  return { tone: 'danger', label: 'Not eligible' };
}

/**
 * Every message the API gave with the result (reasons, then permitted alternatives). A passing
 * result keeps only the "complete the required acknowledgments" alternative, which is what is left
 * to do; the alternatives to a refusal are shown only when the result does not pass.
 */
export function eligibilityMessages(result: EligibilityResult): {
  reasons: string[];
  alternatives: string[];
} {
  const passes = result.eligible || result.overridden;
  return {
    reasons: result.reasons.map((r) => r.message),
    alternatives: result.alternatives
      .filter((a) => !passes || a.kind === 'complete_acknowledgment')
      .map((a) => a.message),
  };
}
