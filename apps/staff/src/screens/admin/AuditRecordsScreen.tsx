/**
 * SCR-S-46 audited privileged actions (§4.14, §2.1, SPK-STAFF-004; SPK-UX-008, SPK-UX-009): the
 * audit records browser over `GET /v1/audit-records` (K-08), newest first with the API's cursor.
 *
 * - Filters (target type and id, actor person, action, operation, correlation, occurred from and
 *   to) are applied when "Show records" is pressed, so each read is one deliberate audited read
 *   (the API audits every read of the audit); they stay in page state, never in the address.
 * - Ids are checked before anything is sent; the API's VALIDATION_FAILED is shown with its field
 *   messages.
 * - ACCESS_DENIED (core.view_audit: general manager and system administration, Proposed) is "not
 *   available to you" with the API's message; offline shows what was loaded with its age.
 */
import { useState, type FormEvent } from 'react';
import { AuditRecordList, type AuditFilters } from '../../features/insight-admin/audit';
import { TextField } from '../../features/insight-admin/fields';
import {
  deviceTimeZone,
  localDateTimeToInstant,
  UUID_PATTERN,
} from '../../features/insight-admin/format';
import { AdminNav } from '../../features/insight-admin/nav';
import { Button } from '../../ui/Button';

interface Draft {
  targetType: string;
  targetId: string;
  actorPersonId: string;
  action: string;
  operationId: string;
  correlationId: string;
  from: string;
  to: string;
}

const EMPTY: Draft = {
  targetType: '',
  targetId: '',
  actorPersonId: '',
  action: '',
  operationId: '',
  correlationId: '',
  from: '',
  to: '',
};

/** Validates the draft and builds the API query (only the filters that were filled in). */
export function buildAuditFilters(draft: Draft): {
  filters: AuditFilters | null;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const filters: AuditFilters = {};
  const text = (key: 'targetType' | 'targetId' | 'action' | 'correlationId', max: number) => {
    const value = draft[key].trim();
    if (!value) return;
    if (value.length > max) errors[key] = `Use at most ${max} characters.`;
    else filters[key] = value;
  };
  text('targetType', 100);
  text('targetId', 200);
  text('action', 200);
  text('correlationId', 200);
  for (const key of ['actorPersonId', 'operationId'] as const) {
    const value = draft[key].trim();
    if (!value) continue;
    if (!UUID_PATTERN.test(value)) errors[key] = 'Enter a full id.';
    else filters[key] = value;
  }
  const from = draft.from ? localDateTimeToInstant(draft.from) : null;
  const to = draft.to ? localDateTimeToInstant(draft.to) : null;
  if (draft.from && !from) errors.from = 'Enter a valid start.';
  if (draft.to && !to) errors.to = 'Enter a valid end.';
  if (from && to && to <= from) errors.to = 'The end must be after the start.';
  if (from) filters.from = from;
  if (to) filters.to = to;
  return { filters: Object.keys(errors).length > 0 ? null : filters, errors };
}

export function AuditRecordsScreen() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<AuditFilters>({});
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const built = buildAuditFilters(draft);
    setErrors(built.errors);
    if (built.filters) setApplied(built.filters);
  };
  const clear = () => {
    setDraft(EMPTY);
    setErrors({});
    setApplied({});
  };
  return (
    <section aria-labelledby="audit-title" className="ia-screen">
      <h2 id="audit-title">Audit records</h2>
      <AdminNav />
      <p className="caption">
        Privileged actions as the API audited them, newest first. Reading the audit is itself an
        audited action (§4.14).
      </p>
      <form className="ia-form" onSubmit={submit} aria-label="Filter audit records" noValidate>
        <div className="ia-filters">
          <TextField
            label="Target type"
            value={draft.targetType}
            onChange={(targetType) => set({ targetType })}
            hint="For example staff_membership or capability."
            error={errors.targetType}
          />
          <TextField
            label="Target id"
            value={draft.targetId}
            onChange={(targetId) => set({ targetId })}
            error={errors.targetId}
          />
          <TextField
            label="Actor person id"
            value={draft.actorPersonId}
            onChange={(actorPersonId) => set({ actorPersonId })}
            error={errors.actorPersonId}
          />
          <TextField
            label="Action"
            value={draft.action}
            onChange={(action) => set({ action })}
            hint="For example identity.manage_staff_membership."
            error={errors.action}
          />
          <TextField
            label="Operation id"
            value={draft.operationId}
            onChange={(operationId) => set({ operationId })}
            error={errors.operationId}
          />
          <TextField
            label="Correlation reference"
            value={draft.correlationId}
            onChange={(correlationId) => set({ correlationId })}
            hint="The reference an error message gave."
            error={errors.correlationId}
          />
          <TextField
            label="Occurred from"
            type="datetime-local"
            value={draft.from}
            onChange={(from) => set({ from })}
            hint={`Your time zone (${deviceTimeZone()}).`}
            error={errors.from}
          />
          <TextField
            label="Occurred before"
            type="datetime-local"
            value={draft.to}
            onChange={(to) => set({ to })}
            error={errors.to}
          />
        </div>
        <div className="ia-actions">
          <Button type="submit">Show records</Button>
          <Button variant="secondary" onClick={clear}>
            Clear filters
          </Button>
        </div>
      </form>
      <section className="ia-section" aria-labelledby="audit-results-title">
        <h3 id="audit-results-title">Records</h3>
        <AuditRecordList
          key={JSON.stringify(applied)}
          filters={applied}
          label="Audit records"
          emptyText="No audited action matches these filters."
        />
      </section>
    </section>
  );
}
