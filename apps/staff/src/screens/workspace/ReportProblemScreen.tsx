/**
 * Field-side "report a problem" (SPK-FAC-002 any staff may report a maintenance issue; SPK-UX-007
 * phone-first beside a field). Three choices and one button: where (the facility's spaces from
 * `GET /v1/resources?facilityId`), what (a short list of common problems, or "Other" with words),
 * and how urgent (the API's severities written out). It sends the facilities module's existing
 * command `POST /v1/maintenance-tasks` with one idempotency key per intent; facilities staff triage
 * from there. Nothing else is invented:
 *
 * - closing the space until it is fixed is an operating restriction, which facilities staff create
 *   and approve (SPK-FAC-004), so it is not offered here; the urgency is how the reporter says so;
 * - photos need an evidence store, which is not set up (evidence is stored by reference only).
 *
 * Reporting needs a connection: the offline queue carries arrival and attendance only (§4.15).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { AreaTabs, WORKSPACE_TABS } from '../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../features/operations/context';
import { ChooseFacility, CommandError, CommandSuccess } from '../../features/operations/feedback';
import { TextAreaField } from '../../features/operations/fields';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { StateView } from '../../ui/StateView';
import './workspace.css';

type Severity = Schema<'ReportMaintenanceTaskBody'>['severity'];

const WHATS: readonly { id: string; label: string; icon: IconName }[] = [
  { id: 'goal', label: 'Goal or net', icon: 'sports_soccer' },
  { id: 'lights', label: 'Lights', icon: 'lightbulb' },
  { id: 'turf', label: 'Turf or floor', icon: 'grass' },
  { id: 'boards', label: 'Boards or fence', icon: 'fence' },
  { id: 'spill', label: 'Spill or leak', icon: 'water_drop' },
  { id: 'equipment', label: 'Equipment', icon: 'construction' },
  { id: 'security', label: 'Security', icon: 'shield_person' },
  { id: 'other', label: 'Other', icon: 'more_horiz' },
];

const SEVERITIES: readonly { value: Severity; label: string; hint: string }[] = [
  { value: 'low', label: 'Can wait', hint: 'Fix when convenient' },
  { value: 'medium', label: 'Soon', hint: 'Fix in the next few days' },
  { value: 'high', label: 'Today', hint: 'Affects play today' },
  { value: 'critical', label: 'Unsafe now', hint: 'Someone could get hurt' },
];

export function ReportProblemScreen() {
  const { online } = useApp();
  const facility = useOperatingFacility();
  const [where, setWhere] = useState('');
  const [what, setWhat] = useState('');
  const [details, setDetails] = useState('');
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [sent, setSent] = useState<string | null>(null);
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId: facility.facilityId ?? '' } },
    enabled: facility.facilityId !== null,
  });
  const report = useApiCommand('post', '/maintenance-tasks', {
    invalidate: [['api', '/maintenance-tasks']],
  });
  const spaces = resources.data ?? [];
  const whatLabel = WHATS.find((w) => w.id === what)?.label ?? '';
  const issue = [whatLabel, details.trim()].filter(Boolean).join(': ');
  const ready =
    online &&
    facility.facilityId !== null &&
    where !== '' &&
    what !== '' &&
    severity !== '' &&
    (what !== 'other' || details.trim().length > 0);

  const send = () => {
    if (!ready || !facility.facilityId) return;
    const spaceName = spaces.find((s) => s.id === where)?.name ?? 'the space';
    void report
      .submit({
        body: { facilityId: facility.facilityId, resourceId: where, issue, severity },
      })
      .then(() => {
        setSent(`Sent to facilities: ${whatLabel} at ${spaceName}`);
        setWhere('');
        setWhat('');
        setDetails('');
        setSeverity('');
      })
      .catch(() => undefined);
  };

  return (
    <section aria-labelledby="report-problem-title" className="ops-screen ws-report">
      <h2 id="report-problem-title">Report a problem</h2>
      <AreaTabs label="Workspace screens" tabs={WORKSPACE_TABS} />
      {!facility.facilityId ? (
        facility.loading ? (
          <StateView variant="loading" label="your facilities" />
        ) : (
          <ChooseFacility purpose="report a problem" />
        )
      ) : (
        <>
          {!online ? (
            <StateView
              variant="unavailable"
              title="Needs a connection"
              description="Reporting a problem needs a connection. Tell the front desk if it cannot wait."
            />
          ) : null}
          <fieldset className="ws-pick">
            <legend>Where</legend>
            {resources.error ? (
              <CommandError
                error={resources.error}
                onRetry={() => void resources.refetch()}
                subject="The spaces of this facility"
              />
            ) : !resources.data ? (
              <p className="caption">Reading the spaces…</p>
            ) : spaces.length === 0 ? (
              <p className="caption">This facility lists no spaces.</p>
            ) : (
              <div className="ws-chips">
                {spaces.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="ws-chip"
                    aria-pressed={where === s.id}
                    onClick={() => setWhere(s.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
          <fieldset className="ws-pick">
            <legend>What</legend>
            <div className="ws-chips ws-chips-grid">
              {WHATS.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="ws-chip"
                  aria-pressed={what === w.id}
                  onClick={() => setWhat(w.id)}
                >
                  <Icon name={w.icon} size={18} />
                  {w.label}
                </button>
              ))}
            </div>
          </fieldset>
          <TextAreaField
            label={what === 'other' ? 'What is wrong (required)' : 'Anything to add'}
            value={details}
            onChange={setDetails}
            rows={2}
          />
          <fieldset className="ws-pick">
            <legend>How urgent</legend>
            <div className="ws-chips ws-chips-grid">
              {SEVERITIES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className="ws-chip ws-chip-stack"
                  data-severity={s.value}
                  aria-pressed={severity === s.value}
                  onClick={() => setSeverity(s.value)}
                >
                  <span>{s.label}</span>
                  <span className="caption">{s.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <p className="caption">
            Closing the space until it is fixed is decided by facilities staff. Photos cannot be
            attached yet: no evidence store is set up.
          </p>
          <div className="ops-actions ws-report-send">
            <Button busy={report.isProcessing} disabled={!ready} onClick={send}>
              Send to facilities
            </Button>
          </div>
          {sent ? <CommandSuccess label={sent} /> : null}
          {report.error ? (
            <CommandError
              error={report.error}
              onRetry={() => void report.resend()}
              subject="This report"
            />
          ) : null}
        </>
      )}
    </section>
  );
}
