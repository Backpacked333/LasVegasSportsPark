/**
 * The facts an activity card answers with (handoff 1d rows 3 and 4): its sessions (the meeting
 * pattern and the clash check, `GET /v1/offerings/{id}/sessions`) and its places left
 * (`GET /v1/offering-availability`, at most 20 activities per read). A failed read leaves its
 * answer out: never a guess.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiRecords } from '../registration/queries';
import { useApiReads, useSignedIn } from '../today/queries';

type Availability = Schema<'OfferingAvailability'>;
type OfferingSession = Schema<'OfferingSession'>;

/** The API reads at most 20 offerings' places at once. */
const AVAILABILITY_BATCH = 20;

export interface ExploreFacts {
  sessionsOf(offeringId: string): OfferingSession[] | undefined;
  availabilityOf(offeringId: string): Availability | undefined;
}

export function useExploreFacts(
  sessionIds: readonly string[],
  availabilityIds: readonly string[],
  enabled = true,
): ExploreFacts {
  const signedIn = useSignedIn();
  const sessions = useApiRecords('/offerings/{id}/sessions', sessionIds, enabled);
  const requests = useMemo(() => {
    const unique = [...new Set(availabilityIds)].sort();
    const out: { query: { offeringIds: string } }[] = [];
    for (let i = 0; i < unique.length; i += AVAILABILITY_BATCH) {
      out.push({ query: { offeringIds: unique.slice(i, i + AVAILABILITY_BATCH).join(',') } });
    }
    return out;
  }, [availabilityIds]);
  const places = useApiReads('/offering-availability', requests, enabled && signedIn);
  const byId = new Map<string, Availability>();
  for (const read of places)
    for (const item of read.data?.items ?? []) byId.set(item.offeringId, item);
  return {
    sessionsOf: (id) => sessions[id]?.data,
    availabilityOf: (id) => byId.get(id),
  };
}
