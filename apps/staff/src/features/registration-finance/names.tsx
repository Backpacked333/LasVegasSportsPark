/**
 * Names for the opaque ids registration and finance records carry (SPK-UX-003: every action shows
 * the participant and the program or team). Each name is read from the API that owns the record
 * (identity, catalog, competition), so the API decides who may see it; a record the viewer may not
 * read is "not available", never "exists but hidden" (§4.10). Only names are shown: no date of
 * birth, contact detail or other child data (§4.14).
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { usePersonName } from '../../api/person-names';
import { useApiQuery } from '../../api/useApiQuery';
import { shortRef } from './format';

/** "not available" only for a protected NOT_FOUND or ACCESS_DENIED; offline is said so (SPK-UX-008). */
function readFailure(error: ApiError, what: string, id: string): string {
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') return `${what} not available`;
  if (presentation === 'offline') return `${what} ${shortRef(id)} (offline)`;
  return `${what} ${shortRef(id)} (could not load: ${error.code})`;
}

/** A person's name through the minimal name read: no child date of birth or contacts cached (§4.14). */
export function PersonName({ id, fallback = 'Person' }: { id: string | null; fallback?: string }) {
  const person = usePersonName(id);
  if (id === null) return <span>{fallback}: none</span>;
  if (person.data) return <span>{`${person.data.givenName} ${person.data.familyName}`}</span>;
  if (person.error) return <span>{readFailure(person.error, fallback, id)}</span>;
  return (
    <span>
      {fallback} {shortRef(id)}
    </span>
  );
}

export function OfferingName({ id }: { id: string | null }) {
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id: id ?? '' } },
    enabled: id !== null,
    staleTime: 5 * 60_000,
  });
  if (id === null) return <span>No offering</span>;
  if (offering.data) return <span>{offering.data.name}</span>;
  if (offering.error) return <span>{readFailure(offering.error, 'Offering', id)}</span>;
  return <span>Offering {shortRef(id)}</span>;
}

export function TeamEntryName({ id }: { id: string | null }) {
  const entry = useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: id ?? '' } },
    enabled: id !== null,
    staleTime: 5 * 60_000,
  });
  if (id === null) return <span>No team entry</span>;
  if (entry.data) return <span>{entry.data.team.name}</span>;
  if (entry.error) return <span>{readFailure(entry.error, 'Team entry', id)}</span>;
  return <span>Team entry {shortRef(id)}</span>;
}
