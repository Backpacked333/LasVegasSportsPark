/**
 * Choose an offering by program (SCR-S-26 waitlists, SCR-S-27 enrollments and transfer targets).
 * The API lists offerings only per program (`GET /v1/programs/{id}/offerings`), so the picker reads
 * programs first, then that program's offerings in any publication state; the API decides what the
 * viewer may list and an ACCESS_DENIED answer shows "not available".
 */
import { presentationForError } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { SelectField } from './fields';
import { PUBLICATION_STATE } from './labels';

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
  const programs = useApiQuery({ path: '/programs', request: { query: { limit: 200 } } });
  const offerings = useApiQuery({
    path: '/programs/{id}/offerings',
    request: { path: { id: programId }, query: { limit: 200 } },
    enabled: programId !== '',
  });
  if (programs.error && presentationForError(programs.error) === 'unavailable') {
    return <p className="caption">{label}: programs are not available to you.</p>;
  }
  const offeringOptions = (offerings.data?.items ?? [])
    .filter((o) => o.id !== excludeId)
    .map((o) => ({
      value: o.id,
      label: `${o.name} (${PUBLICATION_STATE[o.publicationState].label})`,
    }));
  return (
    <div className="rf-grid">
      <SelectField
        label={`${label}: program`}
        value={programId}
        disabled={disabled || !programs.data}
        placeholder={
          programs.data
            ? 'Choose a program'
            : programs.error
              ? 'Programs not available'
              : 'Loading programs…'
        }
        options={(programs.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))}
        onChange={(next) => {
          setProgramId(next);
          onChange('');
        }}
      />
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
                : 'This program has no offerings'
              : offerings.error
                ? 'Offerings not available'
                : 'Loading offerings…'
        }
        options={offeringOptions}
        onChange={onChange}
      />
    </div>
  );
}
