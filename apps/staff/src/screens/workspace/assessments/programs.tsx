/**
 * SCR-W-07 programs by name (SPK-CAT-001, SPK-YOUTH-005, SPK-YOUTH-006): a template belongs to a
 * program, and a recommendation may name the next program. Programs are chosen from
 * `GET /v1/programs` (staff catalogue readers, coaches and program managers among them), paged by
 * the API's cursor and shown by name, never typed as record ids; one already chosen elsewhere (the
 * offering's program) is named with `GET /v1/programs/{id}`. A refused read renders as not
 * available with its code; the client decides nothing about who may read programs.
 */
import type { Schema } from '@sportspark/api-client';
import { useApiPages } from '../../../api/useApiPages';
import { useApiQuery } from '../../../api/useApiQuery';
import { SelectField } from '../../../features/operations/fields';
import { humanize } from '../../../features/operations/format';
import { LoadMore } from '../../../ui/LoadMore';
import { StateView } from '../../../ui/StateView';

export type Program = Schema<'Program'>;

const programKey = (p: Program) => p.id;

function programLabel(p: Pick<Program, 'name' | 'status'>): string {
  return p.status === 'active' ? p.name : `${p.name} (${humanize(p.status).toLowerCase()})`;
}

/** One program's name, when the viewer may read it. */
export function useProgram(programId: string | null) {
  return useApiQuery({
    path: '/programs/{id}',
    request: { path: { id: programId ?? '' } },
    enabled: programId !== null && programId !== '',
    staleTime: 10 * 60_000,
  });
}

export function ProgramPicker({
  label,
  value,
  onChange,
  hint,
  error,
}: {
  label: string;
  value: string;
  onChange: (programId: string, program: Program | null) => void;
  hint?: string;
  error?: string;
}) {
  const programs = useApiPages({
    path: '/programs',
    request: { query: { limit: 50 } },
    keyOf: programKey,
  });
  const items = programs.data ?? [];
  const listed = value === '' || items.some((p) => p.id === value);
  // The chosen program stays visible when it is not on the loaded pages (the offering's program).
  const chosen = useProgram(listed ? null : value);
  const pinned = listed
    ? null
    : { id: value, name: chosen.data?.name ?? '', status: chosen.data?.status ?? 'active' };
  if (programs.error && (programs.error.isPermissionRestriction || programs.error.isNotFound)) {
    return (
      <div>
        <StateView
          variant="unavailable"
          title="Programs are not available"
          description="The list of programs is not available to you, so a program cannot be chosen here."
        />
        <p className="caption">Error code: {programs.error.code}</p>
      </div>
    );
  }
  const options = [
    ...(pinned
      ? [
          {
            value: pinned.id,
            label: pinned.name ? programLabel(pinned) : 'The chosen offering’s program',
          },
        ]
      : []),
    ...items.map((p) => ({ value: p.id, label: programLabel(p) })),
  ];
  return (
    <>
      <SelectField
        label={label}
        value={value}
        onChange={(id) =>
          onChange(id, id ? (items.find((p) => p.id === id) ?? chosen.data ?? null) : null)
        }
        placeholder={
          programs.data === undefined
            ? programs.error
              ? 'Programs could not be loaded'
              : 'Loading programs…'
            : options.length === 0
              ? 'No programs'
              : 'Choose a program'
        }
        disabled={programs.data === undefined && !pinned}
        hint={hint}
        error={error}
        options={options}
      />
      {programs.error ? (
        <StateView variant="error" error={programs.error} onRetry={() => void programs.refetch()} />
      ) : null}
      <LoadMore pages={programs} label="programs" />
    </>
  );
}
