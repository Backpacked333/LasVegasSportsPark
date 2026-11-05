/**
 * Choose one or more spaces from the facility inventory (SPK-SCHED-001): a labelled group of
 * checkboxes (or radios when `single`), subdivisions indented under their pitch so the whole-space
 * relationship is visible. Only resources the API listed can be chosen, so an area outside the
 * inventory cannot be entered (SCR-S-42 validation failure "affected area not in inventory").
 */
import type { Schema } from '@sportspark/api-client';
import { useId } from 'react';
import { orderedInventory } from './inventory';
import { RESOURCE_KIND_LABEL } from './labels';

type Resource = Schema<'Resource'>;

export function ResourceChecklist({
  legend,
  resources,
  value,
  onChange,
  single = false,
  error,
  disabled = false,
}: {
  legend: string;
  resources: readonly Resource[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  error?: string | null;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset
      className="resource-checklist"
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${name}-error` : undefined}
    >
      <legend>{legend}</legend>
      {resources.length === 0 ? (
        <p className="caption">No spaces are set up at this facility.</p>
      ) : null}
      {orderedInventory(resources).map(({ resource, depth }) => (
        <label key={resource.id} style={{ marginInlineStart: `${depth * 20}px` }}>
          <input
            type={single ? 'radio' : 'checkbox'}
            name={name}
            checked={value.includes(resource.id)}
            onChange={(e) => {
              if (single) onChange([resource.id]);
              else
                onChange(
                  e.target.checked
                    ? [...value, resource.id]
                    : value.filter((id) => id !== resource.id),
                );
            }}
          />{' '}
          {resource.name} ({RESOURCE_KIND_LABEL[resource.kind]}
          {resource.status !== 'active' ? `, ${resource.status}` : ''})
        </label>
      ))}
      {error ? (
        <span className="error-text" id={`${name}-error`}>
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
