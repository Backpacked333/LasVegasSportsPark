/**
 * SCR-S-08 rule-set form (SPK-COMP-002, SPK-UX-008 validation failure, SPK-UX-009): every listed
 * rule, with the sections that do not apply to the chosen format disabled ("irrelevant fields
 * remain disabled"); tiebreakers are ordered with the keyboard-operable `ReorderableList`. Nothing
 * is preset (DEC-002): a next version starts from the version it supersedes.
 */
import { useState } from 'react';
import { CheckboxField, SelectField, TextField } from '../../features/competition/fields';
import { SPORT_FORMAT } from '../../features/competition/labels';
import { Button } from '../../ui/Button';
import { ReorderableList } from '../../ui/ReorderableList';
import {
  COMMON_SECTIONS,
  FORMAT_SECTIONS,
  STAFF_ROLES,
  TIEBREAKERS,
  leafDisabled,
  type Leaf,
  type RuleDraft,
  type SportFormat,
  type StaffRoleName,
  type Tiebreaker,
} from './rule-set-form';

function LeafField({
  leaf,
  value,
  disabled,
  error,
  onChange,
}: {
  leaf: Leaf;
  value: string;
  disabled: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  if (leaf.kind === 'bool' || leaf.kind === 'enum') {
    const options =
      leaf.kind === 'bool'
        ? [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]
        : leaf.options;
    return (
      <SelectField
        label={leaf.label}
        hint={leaf.hint}
        required={!disabled}
        disabled={disabled}
        value={value}
        onChange={onChange}
        options={options}
        error={disabled ? undefined : error}
      />
    );
  }
  return (
    <TextField
      label={leaf.label}
      hint={leaf.hint}
      required={!disabled && !(leaf.kind === 'int' && leaf.nullable)}
      disabled={disabled}
      value={value}
      onChange={onChange}
      inputMode={leaf.kind === 'int' ? 'numeric' : 'text'}
      error={disabled ? undefined : error}
    />
  );
}

function RoleChoices({
  legend,
  selected,
  onChange,
  error,
}: {
  legend: string;
  selected: readonly StaffRoleName[];
  onChange: (roles: StaffRoleName[]) => void;
  error?: string;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="field-grid">
        {STAFF_ROLES.map((role) => (
          <CheckboxField
            key={role.value}
            label={role.label}
            checked={selected.includes(role.value)}
            onChange={(checked) =>
              onChange(
                checked
                  ? [...selected, role.value]
                  : selected.filter((value) => value !== role.value),
              )
            }
          />
        ))}
      </div>
      {error ? (
        <span className="error-text" role="alert">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

function Tiebreakers({
  value,
  onChange,
  error,
}: {
  value: Tiebreaker[];
  onChange: (value: Tiebreaker[]) => void;
  error?: string;
}) {
  const [adding, setAdding] = useState('');
  const remaining = TIEBREAKERS.filter((t) => !value.includes(t.value));
  const labelOf = (t: Tiebreaker) => TIEBREAKERS.find((x) => x.value === t)?.label ?? t;
  return (
    <fieldset>
      <legend>Tiebreakers, in the order they are applied</legend>
      {value.length > 0 ? (
        <ReorderableList
          label="Tiebreaker order"
          items={value}
          getKey={(t) => t}
          getLabel={labelOf}
          onMove={(from, to) => {
            const next = [...value];
            const [item] = next.splice(from, 1);
            if (item !== undefined) next.splice(to, 0, item);
            onChange(next);
          }}
          renderItem={(t) => (
            <span className="actions">
              <span>{labelOf(t)}</span>
              <Button
                variant="secondary"
                aria-label={`Remove tiebreaker ${labelOf(t)}`}
                onClick={() => onChange(value.filter((x) => x !== t))}
              >
                Remove
              </Button>
            </span>
          )}
        />
      ) : (
        <p className="caption">No tiebreaker added yet.</p>
      )}
      <div className="actions">
        <SelectField
          label="Add a tiebreaker"
          value={adding}
          onChange={setAdding}
          options={remaining}
        />
        <Button
          variant="secondary"
          disabled={!adding}
          onClick={() => {
            if (!adding) return;
            onChange([...value, adding as Tiebreaker]);
            setAdding('');
          }}
        >
          Add tiebreaker
        </Button>
      </div>
      {error ? (
        <span className="error-text" role="alert">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

export function RuleSetFields({
  format,
  draft,
  onChange,
  errors,
}: {
  format: SportFormat | '';
  draft: RuleDraft;
  onChange: (draft: RuleDraft) => void;
  errors: Record<string, string>;
}) {
  const setValue = (path: string, value: string) =>
    onChange({ ...draft, values: { ...draft.values, [path]: value } });
  const values =
    format === 'indoor_boarded'
      ? { ...draft.values, 'substitutions.rolling': 'yes' }
      : draft.values;
  return (
    <>
      {COMMON_SECTIONS.map((section) => (
        <fieldset key={section.id} disabled={!format}>
          <legend>{section.title}</legend>
          <div className="field-grid">
            {section.leaves.map((leaf) => (
              <LeafField
                key={leaf.path}
                leaf={leaf}
                value={values[leaf.path] ?? ''}
                disabled={!format || leafDisabled(leaf, format, values)}
                error={errors[leaf.path]}
                onChange={(v) => setValue(leaf.path, v)}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <Tiebreakers
        value={draft.tiebreakers}
        onChange={(tiebreakers) => onChange({ ...draft, tiebreakers })}
        error={errors.tiebreakers}
      />
      <RoleChoices
        legend="Roles that submit results"
        selected={draft.submitRoles}
        onChange={(submitRoles) => onChange({ ...draft, submitRoles })}
        error={errors['resultApproval.submitRoles']}
      />
      <RoleChoices
        legend="Roles that publish results (with the league manager)"
        selected={draft.approveRoles}
        onChange={(approveRoles) => onChange({ ...draft, approveRoles })}
        error={errors['resultApproval.approveRoles']}
      />
      {FORMAT_SECTIONS.map((section) => {
        const applies = section.format === format;
        return (
          <fieldset
            key={section.id}
            disabled={!applies}
            aria-describedby={applies ? undefined : `${section.id}-not-applicable`}
          >
            <legend>{section.title}</legend>
            {!applies ? (
              <p className="caption" id={`${section.id}-not-applicable`}>
                {format
                  ? `Does not apply to ${SPORT_FORMAT[format]}: these fields stay disabled and are not saved.`
                  : 'Choose the format first.'}
              </p>
            ) : null}
            <div className="field-grid">
              {section.leaves.map((leaf) => (
                <LeafField
                  key={leaf.path}
                  leaf={leaf}
                  value={applies ? (values[leaf.path] ?? '') : ''}
                  disabled={!applies}
                  error={errors[leaf.path]}
                  onChange={(v) => setValue(leaf.path, v)}
                />
              ))}
            </div>
          </fieldset>
        );
      })}
    </>
  );
}
