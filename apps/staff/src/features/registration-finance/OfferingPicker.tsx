/**
 * Choose an offering by program (SCR-S-25 add line, SCR-S-26 waitlists, SCR-S-27 enrollments and
 * transfer targets). Staff pick the program (`GET /v1/programs`), then one of its offerings in any
 * publication state (`GET /v1/programs/{id}/offerings`); the API decides what the viewer may list
 * and an ACCESS_DENIED answer shows "not available". Both lists are the API's keyset pages: while
 * the API says more exist, "Load more programs" or "Load more offerings" sits next to the choice,
 * so nothing is cut off silently (§4.5). (The staff view of `GET /v1/offerings?view=staff` lists
 * offerings across programs by facility; choosing by program keeps the list short.)
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiPages } from '../../api/useApiPages';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { SelectField } from './fields';
import { PUBLICATION_STATE } from './labels';

// SPK-UX-008: "not available" only for a permission answer; offline or a failed read says so and
// offers Try again.
function failure(error: ApiError | null, what: string): string | null {
  if (!error) return null;
  const presentation = presentationForError(error);
  if (presentation === 'offline') return `${what} could not load (offline)`;
  if (presentation === 'unavailable') return `${what} not available`;
  return `${what} could not load (${error.code})`;
}

export function OfferingPicker({
  label,
  value,
  onChange,
  excludeId,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (offeringId: string) => void;
  excludeId?: string;
  disabled?: boolean;
}) {
  const [programId, setProgramId] = useState('');
  const programs = useApiPages({ path: '/programs', request: { query: { limit: 100 } } });
  const offerings = useApiPages({
    path: '/programs/{id}/offerings',
    request: { path: { id: programId }, query: { limit: 100 } },
    enabled: programId !== '',
  });
  if (programs.error && presentationForError(programs.error) === 'unavailable') {
    return <p className="caption">{label}: programs are not available to you.</p>;
  }
  const offeringOptions = (offerings.data ?? [])
    .filter((o) => o.id !== excludeId)
    .map((o) => ({
      value: o.id,
      label: `${o.name} (${PUBLICATION_STATE[o.publicationState].label})`,
    }));
  const what = label.toLowerCase();
  return (
    <div className="rf-grid">
      <SelectField
        label={`${label}: program`}
        value={programId}
        disabled={disabled || !programs.data}
        placeholder={
          programs.data
            ? 'Choose a program'
            : (failure(programs.error, 'Programs') ?? 'Loading programs…')
        }
        options={(programs.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
        onChange={(next) => {
          setProgramId(next);
          onChange('');
        }}
      />
      <LoadMore pages={programs} label={`programs (${what})`} />
      <SelectField
        label={`${label}: offering`}
        value={value}
        disabled={disabled || programId === '' || !offerings.data}
        placeholder={
          programId === ''
            ? 'Choose a program first'
            : offerings.data
              ? offeringOptions.length > 0
                ? 'Choose an offering'
                : offerings.hasNextPage
                  ? 'None on the first page: load more offerings'
                  : 'This program has no offerings'
              : (failure(offerings.error, 'Offerings') ?? 'Loading offerings…')
        }
        options={offeringOptions}
        onChange={onChange}
      />
      {programId !== '' ? <LoadMore pages={offerings} label={`offerings (${what})`} /> : null}
      {programs.error && !programs.data ? (
        <Button variant="secondary" onClick={() => void programs.refetch()}>
          Try again
        </Button>
      ) : offerings.error && !offerings.data ? (
        <Button variant="secondary" onClick={() => void offerings.refetch()}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
