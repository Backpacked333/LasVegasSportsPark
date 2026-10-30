/**
 * SCR-W-07 progression recommendations (SPK-YOUTH-006; ENR-14 `POST /v1/progression-
 * recommendations`, `/share`, `/withdraw`; capability youth_progression, DEC-016; what a
 * recommendation may draw on is DEC-055, pending).
 *
 * - A program manager or an accepted coach of the offering drafts a recommendation of the next
 *   offering or program, chosen explicitly (nothing preselected), with the suitability in words.
 *   Offerings come from the published catalogue of the facility (`GET /v1/offerings`); programs
 *   by name from `GET /v1/programs` (ProgramPicker).
 * - For an offering the API records a read-only eligibility evaluation; unknown stays unknown and
 *   nothing is shown as eligible without the API saying so. A recommendation reserves nothing and
 *   does not guarantee acceptance, availability or purchase.
 * - Sharing with the family is a separate command with `expectedRevision`; withdrawing needs a
 *   reason, sends `expectedRevision` too and is never gated by the switch.
 * - The API has no staff read or list of recommendations, so only those made on this page are
 *   shown (Proposed handling of an API gap), named by what was chosen, and a STALE_REVISION answer
 *   cannot be reloaded: it is shown with its code. Times are in the offering's facility zone.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo, useState } from 'react';
import { usePermissions } from '../../../api/permissions';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiPages } from '../../../api/useApiPages';
import { useFacilityZone } from '../../../features/operations/context';
import { CommandError, CommandSuccess } from '../../../features/operations/feedback';
import { SelectField, TextAreaField, fieldErrorsOf } from '../../../features/operations/fields';
import { formatInstant, humanize } from '../../../features/operations/format';
import { RECOMMENDATION_STATUS } from '../../../features/operations/labels';
import { Button } from '../../../ui/Button';
import { LoadMore } from '../../../ui/LoadMore';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { ProgramPicker } from './programs';
import { ACTIONS, YOUTH_CAPABILITY, type AssessmentSubject, type Recommendation } from './subject';
import { StaleWithoutRead } from './Templates';

type Offering = Schema<'OfferingListItem'>;
type Reason = { code?: unknown; message?: unknown; severity?: unknown };

const offeringKey = (o: Offering) => o.id;

/** The recorded evaluation, read defensively: anything not stated is unknown, never eligible. */
function eligibilityOf(value: Recommendation['eligibility']) {
  if (!value) return null;
  const eligible = typeof value.eligible === 'boolean' ? value.eligible : null;
  const reasons = Array.isArray(value.reasons)
    ? (value.reasons as Reason[]).filter((r) => r && typeof r.message === 'string')
    : [];
  const unknown = eligible === null || reasons.some((r) => r.severity === 'unknown');
  return { eligible, reasons, unknown };
}

export function Recommendations({ subject }: { subject: AssessmentSubject }) {
  const permissions = usePermissions();
  const capabilityOn = permissions.isCapabilityEnabled(YOUTH_CAPABILITY) === true;
  const mayRecommend = permissions.isPermitted(ACTIONS.recommend, subject.facilityId) === true;
  const [made, setMade] = useState<Recommendation[]>([]);
  // What each recommendation made here names (the offering or program chosen), by its id.
  const [named, setNamed] = useState<ReadonlyMap<string, string>>(new Map());
  const replace = (next: Recommendation) =>
    setMade((prev) => prev.map((r) => (r.id === next.id ? next : r)));
  return (
    <section className="ops-section" aria-labelledby="recommendations-title">
      <h3 id="recommendations-title">Next step for {subject.name}</h3>
      <StateView
        variant="pending-decision"
        subject="Which approved information a recommendation may use"
        decisions={['DEC-055']}
        owner="Program manager"
      />
      {made.length > 0 ? (
        <ul className="list" aria-label="Recommendations made here">
          {made.map((r) => (
            <RecommendationCard
              key={r.id}
              recommendation={r}
              recommended={named.get(r.id) ?? null}
              subject={subject}
              capabilityOn={capabilityOn}
              onChange={replace}
            />
          ))}
        </ul>
      ) : (
        <p className="caption">
          Recommendations made here are listed below; the service does not list earlier ones.
        </p>
      )}
      {capabilityOn && mayRecommend ? (
        <RecommendForm
          subject={subject}
          onMade={(r, name) => {
            setMade((prev) => [r, ...prev]);
            setNamed((prev) => new Map(prev).set(r.id, name));
          }}
        />
      ) : null}
    </section>
  );
}

function RecommendForm({
  subject,
  onMade,
}: {
  subject: AssessmentSubject;
  onMade: (r: Recommendation, name: string) => void;
}) {
  const [target, setTarget] = useState<'offering' | 'program' | ''>('');
  const [choice, setChoice] = useState('');
  const [programName, setProgramName] = useState('');
  const [suitability, setSuitability] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const offerings = useApiPages({
    path: '/offerings',
    request: { query: { facilityId: subject.facilityId, limit: 50, view: 'public' } },
    keyOf: offeringKey,
  });
  const others = useMemo(
    () => (offerings.data ?? []).filter((o) => o.id !== subject.offeringId),
    [offerings.data, subject.offeringId],
  );
  const command = useApiCommand('post', '/progression-recommendations');
  const apiErrors = fieldErrorsOf(command.error);
  const submit = () => {
    const next: Record<string, string> = {};
    if (!target) next.target = 'Choose an offering or a program.';
    else if (!choice)
      next.choice = target === 'offering' ? 'Choose the offering.' : 'Choose the program.';
    if (!suitability.trim()) next.suitability = 'Explain why it suits the participant.';
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    void command
      .submit({
        body: {
          participantPersonId: subject.personId,
          fromOfferingId: subject.offeringId,
          ...(target === 'offering'
            ? { recommendedOfferingId: choice }
            : { recommendedProgramId: choice }),
          suitability: suitability.trim(),
        },
      })
      .then((r) => {
        const offering = others.find((o) => o.id === choice);
        onMade(
          r,
          target === 'offering' && offering
            ? `${offering.name} (${offering.startsOn} to ${offering.endsOn})`
            : programName || 'The chosen program',
        );
        setChoice('');
        setProgramName('');
        setSuitability('');
      })
      .catch(() => undefined);
  };
  return (
    <form
      className="ops-form"
      aria-label={`Recommend a next step for ${subject.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset
        className="ops-fieldset"
        aria-invalid={problems.target ? true : undefined}
        aria-describedby={problems.target ? 'recommend-target-error' : undefined}
      >
        <legend>Recommend</legend>
        {(
          [
            ['offering', 'A specific offering'],
            ['program', 'A program'],
          ] as const
        ).map(([value, text]) => (
          <label key={value} className="ops-check">
            <input
              type="radio"
              name="recommend-target"
              checked={target === value}
              onChange={() => {
                setTarget(value);
                setChoice('');
              }}
            />
            {text}
          </label>
        ))}
        {problems.target ? (
          <span className="error-text" id="recommend-target-error" role="alert">
            {problems.target}
          </span>
        ) : null}
      </fieldset>
      {target === 'offering' ? (
        <>
          <SelectField
            label="Recommended offering"
            value={choice}
            onChange={setChoice}
            placeholder={
              offerings.data === undefined
                ? offerings.error
                  ? 'Offerings could not be loaded'
                  : 'Loading offerings…'
                : 'Choose'
            }
            disabled={offerings.data === undefined}
            options={others.map((o) => ({
              value: o.id,
              label: `${o.name} (${o.startsOn} to ${o.endsOn})`,
            }))}
            hint="From the published offerings of this facility."
            error={problems.choice ?? apiErrors.recommendedOfferingId}
          />
          {offerings.error ? (
            <StateView
              variant="error"
              error={offerings.error}
              onRetry={() => void offerings.refetch()}
            />
          ) : null}
          <LoadMore pages={offerings} label="offerings" />
        </>
      ) : target === 'program' ? (
        <ProgramPicker
          label="Recommended program"
          value={choice}
          onChange={(id, program) => {
            setChoice(id);
            setProgramName(program?.name ?? '');
          }}
          hint="The program, not a particular offering of it."
          error={problems.choice ?? apiErrors.recommendedProgramId}
        />
      ) : null}
      <TextAreaField
        label="Why it suits the participant"
        value={suitability}
        onChange={setSuitability}
        required
        rows={3}
        hint="It does not reserve a place or guarantee acceptance, availability or purchase."
        error={problems.suitability ?? apiErrors.suitability}
      />
      <div className="ops-actions">
        <Button type="submit" busy={command.isProcessing}>
          Save the recommendation as a draft
        </Button>
      </div>
      {command.error && Object.keys(apiErrors).length === 0 ? (
        <CommandError error={command.error} onRetry={submit} subject="This participant" />
      ) : null}
    </form>
  );
}

function RecommendationCard({
  recommendation: r,
  recommended,
  subject,
  capabilityOn,
  onChange,
}: {
  recommendation: Recommendation;
  /** The offering or program chosen, as named when it was recommended here. */
  recommended: string | null;
  subject: AssessmentSubject;
  capabilityOn: boolean;
  onChange: (r: Recommendation) => void;
}) {
  const permissions = usePermissions();
  const zone = useFacilityZone(subject.facilityId);
  const mayRecommend = permissions.isPermitted(ACTIONS.recommend, subject.facilityId) === true;
  const mayWithdraw =
    permissions.isPermitted(ACTIONS.withdrawRecommendation, subject.facilityId) === true;
  const share = useApiCommand('post', '/progression-recommendations/{id}/share');
  const withdraw = useApiCommand('post', '/progression-recommendations/{id}/withdraw');
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const badge = RECOMMENDATION_STATUS[r.status];
  const eligibility = eligibilityOf(r.eligibility);
  const doShare = () =>
    void share
      .submit({ path: { id: r.id }, body: { expectedRevision: r.revision } })
      .then(onChange)
      .catch(() => undefined);
  const doWithdraw = () => {
    if (!reason.trim()) {
      setMissing(true);
      return;
    }
    setMissing(false);
    void withdraw
      .submit({ path: { id: r.id }, body: { reason: reason.trim(), expectedRevision: r.revision } })
      .then((next) => {
        onChange(next);
        setWithdrawing(false);
      })
      .catch(() => undefined);
  };
  const what = `${r.recommendedOfferingId ? 'An offering' : 'A program'}${recommended ? `: ${recommended}` : ''}`;
  return (
    <li aria-label={`Recommendation: ${r.suitability}`}>
      <div className="row-text">
        <span className="row-title">{what}</span>
        <StatusBadge tone={badge.tone} label={badge.label} />
        <span>{r.suitability}</span>
        {eligibility ? (
          <span data-testid="recommendation-eligibility">
            Eligibility for the recommended offering:{' '}
            <StatusBadge
              tone={eligibility.unknown ? 'neutral' : eligibility.eligible ? 'success' : 'danger'}
              label={
                eligibility.unknown
                  ? 'Not known'
                  : eligibility.eligible
                    ? 'Eligible'
                    : 'Not eligible'
              }
            />
            {eligibility.reasons.length > 0 ? (
              <ul aria-label="Eligibility reasons">
                {eligibility.reasons.map((reasonItem, i) => (
                  <li key={i}>
                    {typeof reasonItem.severity === 'string'
                      ? `${humanize(reasonItem.severity)}: `
                      : ''}
                    {String(reasonItem.message)}
                  </li>
                ))}
              </ul>
            ) : null}
          </span>
        ) : (
          <span className="caption">
            A program carries no eligibility evaluation; eligibility is checked when the family
            registers.
          </span>
        )}
        {r.sharedAt ? (
          <span className="caption">Shared {formatInstant(r.sharedAt, zone)}</span>
        ) : null}
      </div>
      <div className="ops-actions">
        {r.status === 'draft' && capabilityOn && mayRecommend ? (
          <Button busy={share.isProcessing} onClick={doShare}>
            Share with the family
          </Button>
        ) : null}
        {r.status !== 'withdrawn' && mayWithdraw ? (
          <Button
            variant="secondary"
            aria-expanded={withdrawing}
            onClick={() => setWithdrawing((w) => !w)}
          >
            Withdraw
          </Button>
        ) : null}
      </div>
      {withdrawing ? (
        <form
          className="ops-form"
          aria-label="Withdraw this recommendation"
          onSubmit={(event) => {
            event.preventDefault();
            doWithdraw();
          }}
        >
          <TextAreaField
            label="Reason for withdrawing"
            value={reason}
            onChange={setReason}
            required
            error={missing ? 'A reason is required.' : undefined}
          />
          <Button type="submit" busy={withdraw.isProcessing}>
            Confirm withdrawal
          </Button>
        </form>
      ) : null}
      {share.error ? (
        <CommandError error={share.error} onRetry={doShare} subject="This recommendation" />
      ) : null}
      {withdraw.error ? (
        <CommandError error={withdraw.error} onRetry={doWithdraw} subject="This recommendation" />
      ) : null}
      {share.error?.code === 'STALE_REVISION' || withdraw.error?.code === 'STALE_REVISION' ? (
        <StaleWithoutRead what="recommendation" />
      ) : null}
      {share.data && share.data.status === 'shared' ? (
        <CommandSuccess label="Recommendation shared">
          <span className="caption">The family is told in the app; nothing is reserved.</span>
        </CommandSuccess>
      ) : null}
    </li>
  );
}
