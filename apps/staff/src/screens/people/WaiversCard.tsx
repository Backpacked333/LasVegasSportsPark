/**
 * Waivers card on the person record (SPK-REG-011, proposed amendment PA-01; capability
 * `liability_waivers`, DEC-095 pending). Shown only while the organization has turned liability
 * waivers on; with the switch off the card is absent and nothing is asked of the API.
 *
 * `GET /v1/people/{id}/waivers` answers each waiver family judged now: current, lapsed or missing,
 * the version in force, the acceptance that was judged and how it was given, the history (earlier
 * versions and acceptances are kept) and, for staff, the recorded overrides. A paper acceptance
 * reads "Recorded from paper by staff; paper dated ...": never as a signature (SPK-REG-009).
 *
 * Roles holding `catalog.accept_waiver` record an acceptance while online: on this tablet (the
 * named signer accepts digitally) or from a signed paper (a staff entry with the paper's date).
 */
import { presentationForError } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiQuery } from '../../api/useApiQuery';
import {
  ACCEPT_WAIVER_ACTION,
  WaiverAcceptanceForm,
} from '../../features/waivers/WaiverAcceptanceForm';
import {
  WAIVER_STATUS,
  acceptanceMethod,
  acceptanceSigner,
  formatCalendarDate,
  waiverReason,
  type PersonWaiver,
  type WaiverAcceptance,
} from '../../features/waivers/waivers';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandSuccess } from '../../ui/CommandFeedback';
import { RecordRef } from '../../ui/RecordRef';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';

function AcceptanceLine({ acceptance }: { acceptance: WaiverAcceptance }) {
  return (
    <span className="row-text">
      <span className="row-title">
        Version {acceptance.version}: {acceptanceMethod(acceptance)}, {acceptanceSigner(acceptance)}
        {acceptance.status === 'withdrawn' ? ' (no longer counts)' : ''}
      </span>
      <span className="caption">
        {acceptance.method === 'paper' ? 'Entered' : 'Accepted'}{' '}
        {formatDateTime(acceptance.signedAt)}
        {acceptance.recordedByPersonId ? (
          <>
            {' '}
            · staff entry by <RecordRef type="person" id={acceptance.recordedByPersonId} />
          </>
        ) : null}
        {acceptance.withdrawnReason ? ` · ${acceptance.withdrawnReason}` : ''}
      </span>
    </span>
  );
}

function WaiverRow({
  personId,
  waiver,
  canRecord,
  onDone,
}: {
  personId: string;
  waiver: PersonWaiver;
  canRecord: boolean;
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<'tablet' | 'paper' | null>(null);
  const status = WAIVER_STATUS[waiver.status];
  const reason = waiverReason(waiver);
  const earlier = waiver.history.filter(
    (a) => a.acknowledgmentId !== waiver.acceptance?.acknowledgmentId,
  );
  const version = waiver.currentVersion;
  return (
    <li data-status={waiver.status}>
      <span className="row-text">
        <span className="row-title">
          <b>{waiver.title}</b>
          {version ? ` (version ${version.version} in force)` : ''}
        </span>
        <StatusBadge tone={status.tone} label={status.label} />
        {reason ? <span className="caption">{reason}</span> : null}
        {waiver.validUntil ? (
          <span className="caption">
            Counts until {formatCalendarDate(waiver.validUntil.slice(0, 10))}.
          </span>
        ) : null}
        {waiver.rule ? (
          <span className="caption">
            Approved rule: a missing or lapsed waiver{' '}
            {waiver.rule.enforcement === 'block' ? 'blocks' : 'warns and does not block'};{' '}
            {waiver.rule.reacceptOnNewVersion
              ? 'a new version must be accepted again'
              : 'a new version does not need accepting again'}
            ;{' '}
            {waiver.rule.renewEveryMonths
              ? `renewed every ${waiver.rule.renewEveryMonths} months`
              : 'no periodic renewal'}
            .
          </span>
        ) : null}
      </span>
      {waiver.acceptance ? <AcceptanceLine acceptance={waiver.acceptance} /> : null}
      {earlier.length > 0 ? (
        <ul className="list" aria-label={`Earlier acceptances of ${waiver.title}`}>
          {earlier.map((a) => (
            <li key={a.acknowledgmentId}>
              <AcceptanceLine acceptance={a} />
            </li>
          ))}
        </ul>
      ) : null}
      {waiver.overrides.length > 0 ? (
        <ul className="list" aria-label={`Overrides of ${waiver.title}`}>
          {waiver.overrides.map((o) => (
            <li key={o.id}>
              <span className="row-text">
                <span className="row-title">Override: {o.reason}</span>
                <span className="caption">
                  {formatDateTime(o.occurredAt)} · for{' '}
                  <RecordRef type={o.activity.type} id={o.activity.id} /> · by{' '}
                  <RecordRef type="person" id={o.actorPersonId} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {mode && version ? (
        <WaiverAcceptanceForm
          personId={personId}
          policyVersionId={version.policyVersionId}
          mode={mode}
          onCancel={() => setMode(null)}
          onRecorded={() => {
            setMode(null);
            onDone(
              mode === 'paper'
                ? `Paper waiver recorded for ${waiver.title}.`
                : `Waiver acceptance recorded for ${waiver.title}.`,
            );
          }}
        />
      ) : canRecord && version && waiver.status !== 'current' ? (
        <span className="actions-row">
          <Button variant="secondary" onClick={() => setMode('tablet')}>
            Sign on this tablet
          </Button>
          <Button variant="secondary" onClick={() => setMode('paper')}>
            Record paper waiver
          </Button>
        </span>
      ) : null}
    </li>
  );
}

export function WaiversCard({ personId, merged }: { personId: string; merged: boolean }) {
  const { online } = useApp();
  const permissions = usePermissions();
  const enabled = permissions.isCapabilityEnabled('liability_waivers') === true;
  const [outcome, setOutcome] = useState<string | null>(null);
  const waivers = useApiQuery({
    path: '/people/{id}/waivers',
    request: { path: { id: personId } },
    enabled,
  });
  // Turned off (or not yet known): nothing new is shown or asked for.
  if (!enabled) return null;
  const canRecord = online && !merged && permissions.isPermitted(ACCEPT_WAIVER_ACTION) === true;

  let body;
  if (!waivers.data) {
    body = (
      <p className="caption">
        {waivers.error
          ? presentationForError(waivers.error) === 'unavailable'
            ? 'Waivers are not available to you.'
            : `Waivers could not load (${waivers.error.code}).`
          : 'Loading waivers…'}
      </p>
    );
  } else if (!waivers.data.evaluated) {
    body = <p className="caption">Liability waivers are turned off for this organization.</p>;
  } else if (waivers.data.waivers.length === 0) {
    body = <p className="caption">No waiver is in force for this organization.</p>;
  } else {
    body = (
      <ul className="list" aria-label="Waivers">
        {waivers.data.waivers.map((w) => (
          <WaiverRow
            key={w.policyKey}
            personId={personId}
            waiver={w}
            canRecord={canRecord}
            onDone={setOutcome}
          />
        ))}
      </ul>
    );
  }
  return (
    <section className="card" aria-labelledby="waivers-title">
      <div className="card-head">
        <h4 id="waivers-title">Waivers</h4>
        <StatusBadge tone="info" label="Proposed rule, DEC-095 pending" />
      </div>
      <div className="card-body">
        {body}
        <CommandSuccess message={outcome} />
      </div>
    </section>
  );
}
