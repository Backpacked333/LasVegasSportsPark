/**
 * Required forms per participant (SCR-C-11, SCR-C-13; SPK-REG-009, SPK-IAM-003, POL-037): which
 * policy versions each participant must have acknowledged, and which they already have, read from
 * `GET /v1/acknowledgments?subjectPersonId=` (the API's record, not the basket line's snapshot,
 * so a form signed a moment ago counts at once).
 */
import {
  apiQueryKey,
  type ApiError,
  type ApiResponse,
  type ResponseBody,
  type Schema,
} from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../providers/AppProviders';

type Acknowledgment = Schema<'Acknowledgment'>;

export interface FormRequirement {
  participantPersonId: string;
  policyVersionIds: readonly string[];
}

export interface FormsStatus {
  /** Active acknowledgment of a participant's policy version, if any. */
  acknowledgment(participantPersonId: string, policyVersionId: string): Acknowledgment | null;
  /** Whether the participant's acknowledgments have been read. */
  known(participantPersonId: string): boolean;
  error(participantPersonId: string): ApiError | null;
  /** Unsigned required forms, counting only participants whose acknowledgments are known. */
  outstanding: number;
  total: number;
  loading: boolean;
  refetch(): void;
}

/** Merges requirements so each participant and policy version appears once. */
export function mergeRequirements(requirements: readonly FormRequirement[]): FormRequirement[] {
  const byParticipant = new Map<string, Set<string>>();
  for (const r of requirements) {
    const set = byParticipant.get(r.participantPersonId) ?? new Set<string>();
    r.policyVersionIds.forEach((id) => set.add(id));
    byParticipant.set(r.participantPersonId, set);
  }
  return [...byParticipant.entries()]
    .filter(([, ids]) => ids.size > 0)
    .map(([participantPersonId, ids]) => ({ participantPersonId, policyVersionIds: [...ids] }));
}

export function useFormsStatus(
  requirements: readonly FormRequirement[],
  enabled = true,
): FormsStatus {
  const api = useApi();
  const merged = mergeRequirements(requirements);
  const results = useQueries({
    queries: merged.map((r) => {
      const query = { subjectPersonId: r.participantPersonId };
      return {
        queryKey: apiQueryKey('/acknowledgments', { query }),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api.request('get', '/acknowledgments', { query, signal }) as Promise<
            ApiResponse<ResponseBody<'/acknowledgments', 'get'>>
          >,
        enabled,
      };
    }),
  });
  const index = new Map(merged.map((r, i) => [r.participantPersonId, i]));
  const resultOf = (personId: string) => {
    const i = index.get(personId);
    return i === undefined ? undefined : results[i];
  };
  const acknowledgment = (personId: string, policyVersionId: string) =>
    resultOf(personId)?.data?.data.find(
      (a) => a.policyVersionId === policyVersionId && a.status === 'active',
    ) ?? null;
  let outstanding = 0;
  let total = 0;
  for (const r of merged) {
    total += r.policyVersionIds.length;
    if (!resultOf(r.participantPersonId)?.data) continue;
    outstanding += r.policyVersionIds.filter(
      (id) => !acknowledgment(r.participantPersonId, id),
    ).length;
  }
  return {
    acknowledgment,
    known: (personId) => resultOf(personId)?.data !== undefined,
    error: (personId) => (resultOf(personId)?.error as ApiError | null | undefined) ?? null,
    outstanding,
    total,
    loading: results.some((r) => r.isPending && enabled),
    refetch: () => results.forEach((r) => void r.refetch()),
  };
}

/** Readable wording of a form's policy version: its `text`, or every text value it holds. */
export function formWording(content: Record<string, unknown>): string[] {
  if (typeof content.text === 'string') return [content.text];
  return Object.values(content).filter((v): v is string => typeof v === 'string' && v.length > 0);
}
