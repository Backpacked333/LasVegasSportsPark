/**
 * SCR-S-14 offering form: every SPK-CAT-001 field of a dated offering (name and description,
 * activity type, format, location, dates and registration window, eligibility, participation
 * entitlement, capacity units with SPK-YOUTH-002 group size and staffing ratio, required forms,
 * cancellation policy, responsible manager). Price and obligations are price rule versions on the
 * setup screen, and publication state is SCR-S-15.
 *
 * - Policies offered are the approved versions the API lists (`GET /v1/policy-versions`); the
 *   entitlement definitions are `GET /v1/entitlement-definitions`. Nothing is preset.
 * - The registration window is entered as wall-clock time in the facility's time zone when the API
 *   states it (SPK-SCHED-008), otherwise in UTC, and the label says which.
 * - The responsible manager is chosen from the staff directory of the offering's facility
 *   (`GET /v1/staff-directory`, ID-04), names and roles only, or entered as a person reference
 *   when the directory is not available to the viewer or the person is not listed. The API
 *   validates that the manager is an active person; no role is preset here.
 * - Input is kept after a validation or stale-version answer (SPK-UX-008).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilities } from '../../features/registration-finance/facilities';
import {
  CheckboxGroup,
  SelectField,
  TextArea,
  TextField,
} from '../../features/registration-finance/fields';
import { instantToLocal, localToInstant } from '../../features/registration-finance/format';
import { CAPACITY_UNIT, OFFERING_KIND } from '../../features/registration-finance/labels';
import { PENDING } from '../../features/registration-finance/pending';
import { Button } from '../../ui/Button';
import { optionalInt } from './ProgramsScreen';

type Offering = Schema<'Offering'>;
type CapacityUnit = Schema<'CapacityUnit'>;
type CapacityUnitKind = Schema<'CapacityUnitKind'>;
type OfferingKind = Schema<'OfferingKind'>;

export type CreateOfferingBody = Schema<'CreateOfferingRequest'>;
export type UpdateOfferingBody = Schema<'UpdateOfferingRequest'>;

interface UnitRow {
  unit: CapacityUnitKind | '';
  limit: string;
  groupSize: string;
  participantsPerStaff: string;
}

function toRows(units: readonly CapacityUnit[]): UnitRow[] {
  return units.map((u) => ({
    unit: u.unit,
    limit: String(u.limit),
    groupSize: u.groupSize?.toString() ?? '',
    participantsPerStaff: u.staffingRatio?.participantsPerStaff.toString() ?? '',
  }));
}

function usePolicyOptions(kind: 'eligibility' | 'cancellation' | 'form') {
  const policies = useApiQuery({
    path: '/policy-versions',
    request: { query: { kind, approvalStatus: 'approved', limit: 200 } },
    staleTime: 60_000,
  });
  return {
    options: (policies.data?.items ?? []).map((p) => ({
      value: p.id,
      label: `${p.title} (version ${p.version})`,
    })),
    unavailable: policies.error !== null && policies.data === undefined,
  };
}

export interface OfferingFormProps {
  mode: 'create' | 'edit';
  programId: string;
  initial: Offering | null;
  busy: boolean;
  disabled: boolean;
  serverErrors: Record<string, string>;
  onCreate?: (body: CreateOfferingBody) => void;
  onUpdate?: (body: UpdateOfferingBody) => void;
}

export function OfferingForm({
  mode,
  programId,
  initial,
  busy,
  disabled,
  serverErrors,
  onCreate,
  onUpdate,
}: OfferingFormProps) {
  const { facilities, timeZoneOf } = useFacilities();
  const staff = initial?.staff ?? null;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [kind, setKind] = useState<OfferingKind | ''>(initial?.kind ?? '');
  const [facilityId, setFacilityId] = useState(initial?.facilityId ?? '');
  const [activityType, setActivityType] = useState(initial?.activityType ?? '');
  const [format, setFormat] = useState(initial?.format ?? '');
  const [locationLabel, setLocationLabel] = useState(initial?.locationLabel ?? '');
  const [startsOn, setStartsOn] = useState(initial?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(initial?.endsOn ?? '');
  const zone = timeZoneOf(facilityId);
  const [opensAt, setOpensAt] = useState(instantToLocal(initial?.registrationOpensAt, zone));
  const [closesAt, setClosesAt] = useState(instantToLocal(initial?.registrationClosesAt, zone));
  const [referenceDate, setReferenceDate] = useState(staff?.eligibilityReferenceDate ?? '');
  const [eligibilityPolicy, setEligibilityPolicy] = useState(
    initial?.eligibilityPolicyVersionId ?? '',
  );
  const [cancellationPolicy, setCancellationPolicy] = useState(
    initial?.cancellationPolicyVersionId ?? '',
  );
  const [forms, setForms] = useState<string[]>(initial?.requiredFormPolicyVersionIds ?? []);
  const [entitlement, setEntitlement] = useState(initial?.entitlementDefinitionId ?? '');
  const [manager, setManager] = useState(staff?.responsibleManagerPersonId ?? '');
  const [units, setUnits] = useState<UnitRow[]>(toRows(staff?.capacityUnits ?? []));
  const [local, setLocal] = useState<Record<string, string>>({});

  const eligibility = usePolicyOptions('eligibility');
  const cancellation = usePolicyOptions('cancellation');
  const formPolicies = usePolicyOptions('form');
  const entitlements = useApiQuery({ path: '/entitlement-definitions', staleTime: 60_000 });
  const entitlementOptions = (entitlements.data ?? [])
    .filter((e) => e.status === 'active' || e.id === entitlement)
    .map((e) => ({ value: e.id, label: e.name }));

  const directory = useApiQuery({
    path: '/staff-directory',
    request: { query: { limit: 200, ...(facilityId ? { facilityId } : {}) } },
    staleTime: 60_000,
  });
  const staffOptions = (directory.data?.items ?? []).map((e) => ({
    value: e.personId,
    label: `${e.displayName} (${e.roles.map((r) => r.replaceAll('_', ' ')).join(', ')})`,
  }));
  const listed = staffOptions.some((o) => o.value === manager.trim());

  const err = (key: string) => local[key] ?? serverErrors[key] ?? null;
  const zoneLabel = zone
    ? `facility time, ${zone}`
    : 'UTC: the facility time zone is not available';

  const updateUnit = (index: number, patch: Partial<UnitRow>) =>
    setUnits((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const submit = () => {
    const errors: Record<string, string> = {};
    if (name.trim() === '') errors.name = 'Enter a name.';
    if (mode === 'create' && kind === '') errors.kind = 'Choose the kind of offering.';
    if (mode === 'create' && facilityId === '') errors.facilityId = 'Choose the facility.';
    if (startsOn === '') errors.startsOn = 'Enter the first date.';
    if (endsOn === '') errors.endsOn = 'Enter the last date.';
    if (startsOn && endsOn && startsOn > endsOn)
      errors.endsOn = 'The last date is before the first.';
    const opens = opensAt ? localToInstant(opensAt, zone) : null;
    const closes = closesAt ? localToInstant(closesAt, zone) : null;
    if (opensAt && !opens) errors.registrationOpensAt = 'Enter a date and time.';
    if (closesAt && !closes) errors.registrationClosesAt = 'Enter a date and time.';
    if (opens && closes && opens >= closes) {
      errors.registrationClosesAt = 'Registration must open before it closes.';
    }
    const capacityUnits: CapacityUnit[] = [];
    units.forEach((row, i) => {
      const limit = optionalInt(row.limit);
      const groupSize = optionalInt(row.groupSize);
      const ratio = optionalInt(row.participantsPerStaff);
      if (row.unit === '') errors[`capacityUnits.${i}.unit`] = 'Choose the unit.';
      if (limit === undefined || Number.isNaN(limit)) {
        errors[`capacityUnits.${i}.limit`] = 'Enter the limit as a whole number.';
      }
      if (Number.isNaN(groupSize)) errors[`capacityUnits.${i}.groupSize`] = 'Whole number.';
      if (Number.isNaN(ratio)) errors[`capacityUnits.${i}.participantsPerStaff`] = 'Whole number.';
      if (row.unit !== '' && limit !== undefined && !Number.isNaN(limit)) {
        capacityUnits.push({
          unit: row.unit,
          limit,
          ...(groupSize !== undefined && !Number.isNaN(groupSize) ? { groupSize } : {}),
          ...(ratio !== undefined && !Number.isNaN(ratio)
            ? { staffingRatio: { participantsPerStaff: ratio } }
            : {}),
        });
      }
    });
    if (new Set(units.map((u) => u.unit)).size !== units.length) {
      errors.capacityUnits = 'Each capacity unit may appear once.';
    }
    setLocal(errors);
    if (Object.keys(errors).length > 0) return;
    const text = (value: string) => value.trim();
    if (mode === 'create' && onCreate) {
      onCreate({
        programId,
        name: text(name),
        kind: kind as OfferingKind,
        facilityId,
        startsOn,
        endsOn,
        capacityUnits,
        requiredFormPolicyVersionIds: forms,
        location: text(locationLabel) ? { label: text(locationLabel) } : {},
        ...(text(description) ? { description: text(description) } : {}),
        ...(text(activityType) ? { activityType: text(activityType) } : {}),
        ...(text(format) ? { format: text(format) } : {}),
        ...(opens ? { registrationOpensAt: opens } : {}),
        ...(closes ? { registrationClosesAt: closes } : {}),
        ...(referenceDate ? { eligibilityReferenceDate: referenceDate } : {}),
        ...(eligibilityPolicy ? { eligibilityPolicyVersionId: eligibilityPolicy } : {}),
        ...(cancellationPolicy ? { cancellationPolicyVersionId: cancellationPolicy } : {}),
        ...(entitlement ? { entitlementDefinitionId: entitlement } : {}),
        ...(text(manager) ? { responsibleManagerPersonId: text(manager) } : {}),
      });
    }
    if (mode === 'edit' && onUpdate && staff) {
      onUpdate({
        expectedRevision: staff.revision,
        name: text(name),
        description: text(description) || null,
        ...(text(activityType) ? { activityType: text(activityType) } : {}),
        format: text(format) || null,
        location: { ...staff.location, label: text(locationLabel) || undefined },
        startsOn,
        endsOn,
        registrationOpensAt: opens,
        registrationClosesAt: closes,
        eligibilityReferenceDate: referenceDate || null,
        eligibilityPolicyVersionId: eligibilityPolicy || null,
        cancellationPolicyVersionId: cancellationPolicy || null,
        requiredFormPolicyVersionIds: forms,
        entitlementDefinitionId: entitlement || null,
        responsibleManagerPersonId: text(manager) || null,
        capacityUnits,
      });
    }
  };

  return (
    <form
      noValidate
      aria-label={mode === 'create' ? 'New offering' : 'Offering configuration'}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset className="rf-fieldset">
        <legend>Description</legend>
        <div className="rf-grid">
          <TextField
            label="Offering name"
            required
            value={name}
            onChange={setName}
            error={err('name')}
          />
          {mode === 'create' ? (
            <SelectField
              label="Kind"
              required
              value={kind}
              placeholder="Choose a kind"
              onChange={(v) => setKind(v as OfferingKind | '')}
              options={Object.entries(OFFERING_KIND).map(([value, label]) => ({ value, label }))}
              error={err('kind')}
            />
          ) : (
            <TextField
              label="Kind"
              value={OFFERING_KIND[initial?.kind ?? 'season']}
              onChange={() => undefined}
              disabled
            />
          )}
          {mode === 'create' && facilities.length > 0 ? (
            <SelectField
              label="Facility"
              required
              value={facilityId}
              placeholder="Choose a facility"
              onChange={setFacilityId}
              options={facilities.map((f) => ({ value: f.id, label: f.name }))}
              error={err('facilityId')}
            />
          ) : (
            <TextField
              label="Facility reference"
              required={mode === 'create'}
              disabled={mode === 'edit'}
              hint={
                mode === 'create'
                  ? 'No facility list is available to you; enter its reference.'
                  : undefined
              }
              value={facilityId}
              onChange={setFacilityId}
              error={err('facilityId')}
            />
          )}
          <TextField
            label="Activity type"
            hint="Leave empty to use the program's."
            value={activityType}
            onChange={setActivityType}
            error={err('activityType')}
          />
          <TextField label="Format" value={format} onChange={setFormat} error={err('format')} />
          <TextField
            label="Location"
            value={locationLabel}
            onChange={setLocationLabel}
            error={err('location')}
          />
        </div>
        <TextArea
          label="Offering description"
          value={description}
          onChange={setDescription}
          error={err('description')}
        />
      </fieldset>

      <fieldset className="rf-fieldset">
        <legend>Dates and registration window</legend>
        <div className="rf-grid">
          <TextField
            label="First date"
            type="date"
            required
            value={startsOn}
            onChange={setStartsOn}
            error={err('startsOn')}
          />
          <TextField
            label="Last date"
            type="date"
            required
            value={endsOn}
            onChange={setEndsOn}
            error={err('endsOn')}
          />
          <TextField
            label={`Registration opens (${zoneLabel})`}
            type="datetime-local"
            value={opensAt}
            onChange={setOpensAt}
            error={err('registrationOpensAt')}
          />
          <TextField
            label={`Registration closes (${zoneLabel})`}
            type="datetime-local"
            value={closesAt}
            onChange={setClosesAt}
            error={err('registrationClosesAt')}
          />
        </div>
      </fieldset>

      <fieldset className="rf-fieldset">
        <legend>Eligibility, entitlement, forms and policies</legend>
        <div className="rf-grid">
          <SelectField
            label="Eligibility policy (approved versions)"
            value={eligibilityPolicy}
            placeholder={eligibility.unavailable ? 'Policies not available' : 'None'}
            options={eligibility.options}
            onChange={setEligibilityPolicy}
            error={err('eligibilityPolicyVersionId')}
          />
          <TextField
            label="Eligibility reference date"
            type="date"
            hint="Ages are evaluated on this date. Leave empty for the first date."
            value={referenceDate}
            onChange={setReferenceDate}
            error={err('eligibilityReferenceDate')}
          />
          <SelectField
            label="Participation entitlement"
            value={entitlement}
            placeholder={entitlements.error ? 'Entitlements not available' : 'None'}
            options={entitlementOptions}
            onChange={setEntitlement}
            error={err('entitlementDefinitionId')}
          />
          <SelectField
            label="Cancellation policy (approved versions)"
            value={cancellationPolicy}
            placeholder={cancellation.unavailable ? 'Policies not available' : 'None'}
            options={cancellation.options}
            onChange={setCancellationPolicy}
            error={err('cancellationPolicyVersionId')}
          />
          {directory.data ? (
            <SelectField
              label="Responsible manager (staff directory)"
              value={listed ? manager.trim() : ''}
              placeholder={staffOptions.length === 0 ? 'No staff listed' : 'Not chosen'}
              options={staffOptions}
              onChange={setManager}
              hint={
                directory.data.nextCursor
                  ? 'More staff exist than are listed: enter a reference below for anyone else.'
                  : undefined
              }
            />
          ) : null}
          <TextField
            label="Responsible manager (person reference)"
            hint={
              directory.error
                ? `The staff directory is not available (${directory.error.code}); enter the person reference.`
                : 'Filled in when a staff member is chosen; or enter a person reference.'
            }
            value={manager}
            onChange={setManager}
            error={err('responsibleManagerPersonId')}
          />
        </div>
        <CheckboxGroup
          legend="Required forms (approved versions)"
          hint={formPolicies.unavailable ? 'Form policies are not available to you.' : undefined}
          options={formPolicies.options}
          values={forms}
          onChange={setForms}
        />
      </fieldset>

      <fieldset className="rf-fieldset">
        <legend>Capacity units</legend>
        <p className="caption">
          Capacity counts active holds and accepted commitments (SPK-REG-005). Group size and the
          staffing ratio limit what commercial capacity can sell (SPK-YOUTH-002). Approved youth
          values are pending {PENDING.youthStaffing.ids.join(', ')} (owner:{' '}
          {PENDING.youthStaffing.owner}); nothing is preset.
        </p>
        {err('capacityUnits') ? <p className="rf-error">{err('capacityUnits')}</p> : null}
        <ul className="list" aria-label="Capacity units">
          {units.map((row, i) => (
            <li key={i}>
              <div className="rf-grid">
                <SelectField
                  label={`Unit ${i + 1}`}
                  value={row.unit}
                  placeholder="Choose a unit"
                  options={Object.entries(CAPACITY_UNIT).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(v) => updateUnit(i, { unit: v as CapacityUnitKind | '' })}
                  error={err(`capacityUnits.${i}.unit`)}
                />
                <TextField
                  label={`Unit ${i + 1} limit`}
                  inputMode="numeric"
                  value={row.limit}
                  onChange={(v) => updateUnit(i, { limit: v })}
                  error={err(`capacityUnits.${i}.limit`)}
                />
                <TextField
                  label={`Unit ${i + 1} group size`}
                  inputMode="numeric"
                  value={row.groupSize}
                  onChange={(v) => updateUnit(i, { groupSize: v })}
                  error={err(`capacityUnits.${i}.groupSize`)}
                />
                <TextField
                  label={`Unit ${i + 1} participants per staff member`}
                  inputMode="numeric"
                  value={row.participantsPerStaff}
                  onChange={(v) => updateUnit(i, { participantsPerStaff: v })}
                  error={err(`capacityUnits.${i}.participantsPerStaff`)}
                />
              </div>
              <Button
                variant="secondary"
                aria-label={`Remove capacity unit ${i + 1}`}
                onClick={() => setUnits((rows) => rows.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          disabled={units.length >= 6}
          onClick={() =>
            setUnits((rows) => [
              ...rows,
              { unit: '', limit: '', groupSize: '', participantsPerStaff: '' },
            ])
          }
        >
          Add a capacity unit
        </Button>
      </fieldset>

      <div className="rf-actions">
        <Button type="submit" busy={busy} disabled={disabled}>
          {mode === 'create' ? 'Create draft offering' : 'Save offering'}
        </Button>
      </div>
    </form>
  );
}
