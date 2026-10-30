/**
 * SCR-S-19 progression recommendations (SPK-YOUTH-006; ENR-14 `POST /v1/progression-
 * recommendations`, `/share`, `/withdraw`; DEC-055 pending; capability `youth_progression`,
 * DEC-016). A program manager or coach of the offering drafts a recommendation for an enrolled
 * child (an offering or a program, chosen explicitly; nothing preselected) with the suitability
 * in words. The API records a read-only eligibility evaluation of a recommended offering
 * (unknown stays unknown) and the recommendation reserves nothing and promises nothing. A draft
 * is shared with the family by a separate command with `expectedRevision`; withdrawing needs a
 * reason and is never gated. Drafting and sharing are new commitments of the capability, so they
 * are offered only while it is on; the recommendations made here stay listed with "Withdraw"
 * when the switch turns off (the turned-off state is a notice above them, never a replacement).
 *
 * The offerings and programs to recommend are paged with "Load more" (published offerings,
 * active programs), so nothing is silently cut off.
 *
 * The API has no read or list of a participant's recommendations for staff, so only the
 * recommendations made on this page are shown (Proposed handling of an API gap). Children are
 * named only: no date of birth, contact or medical detail (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { SuccessNote } from '../../features/competition/feedback';
import { SelectField, TextAreaField } from '../../features/competition/fields';
import { formatInstant } from '../../features/competition/format';
import { ISSUE_SEVERITY, RECOMMENDATION_STATUS } from '../../features/competition/labels';
import { PersonName, type PersonNames } from '../../features/competition/names';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { LoadMore } from '../../ui/LoadMore';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Recommendation = Schema<'ProgressionRecommendation'>;
type Reason = Schema<'RegistrationEligibilityReason'>;

interface EligibilityView {
  eligible: boolean | null;
  reasons: Reason[];
  evaluatedAt: string | null;
}

/** The recorded evaluation, read defensively: unknown evidence is never shown as eligible. */
function eligibilityOf(value: Recommendation['eligibility']): EligibilityView | null {
  if (!value) return null;
  const eligible = typeof value.eligible === 'boolean' ? value.eligible : null;
  const reasons = Array.isArray(value.reasons)
    ? (value.reasons as unknown[]).filter(
        (r): r is Reason =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as Reason).message === 'string' &&
          (r as Reason).severity in ISSUE_SEVERITY,
      )
    : [];
  const evaluatedAt = typeof value.evaluatedAt === 'string' ? value.evaluatedAt : null;
  return { eligible, reasons, evaluatedAt };
}

function EligibilitySummary({ recommendation }: { recommendation: Recommendation }) {
  const view = eligibilityOf(recommendation.eligibility);
  if (!view) {
    return (
      <p className="caption">
        A program recommendation carries no eligibility evaluation; eligibility is checked when the
        family registers.
      </p>
    );
  }
  const unknown = view.eligible === null || view.reasons.some((r) => r.severity === 'unknown');
  const badge = unknown
    ? ISSUE_SEVERITY.unknown
    : view.eligible
      ? { tone: 'success' as const, label: 'Eligible' }
      : { tone: 'danger' as const, label: 'Not eligible' };
  return (
    <div className="row-text" data-testid="recommendation-eligibility">
      <span>
        Eligibility for the recommended offering:{' '}
        <span data-testid="eligibility-summary">
          <StatusBadge tone={badge.tone} label={badge.label} />
        </span>
        {view.evaluatedAt ? (
          <span className="caption"> evaluated {formatInstant(view.evaluatedAt)}</span>
        ) : null}
      </span>
      {view.reasons.length > 0 ? (
        <ul aria-label="Eligibility reasons">
          {view.reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`}>
              <StatusBadge
                tone={ISSUE_SEVERITY[reason.severity].tone}
                label={ISSUE_SEVERITY[reason.severity].label}
              />{' '}
              {reason.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function RecommendationCard({
  recommendation,
  names,
  canShare,
  onChange,
}: {
  recommendation: Recommendation;
  names: PersonNames;
  /** Sharing is a new commitment of `youth_progression`; withdrawing never is. */
  canShare: boolean;
  onChange: (next: Recommendation) => void;
}) {
  const share = useApiCommand('post', '/progression-recommendations/{id}/share');
  const withdraw = useApiCommand('post', '/progression-recommendations/{id}/withdraw');
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const badge = RECOMMENDATION_STATUS[recommendation.status];
  const doShare = () =>
    void share
      .submit({
        path: { id: recommendation.id },
        body: { expectedRevision: recommendation.revision },
      })
      .then(onChange)
      .catch(() => undefined);
  const doWithdraw = () => {
    if (!reason.trim()) {
      setError('Give the reason for withdrawing the recommendation.');
      return;
    }
    setError(null);
    void withdraw
      .submit({ path: { id: recommendation.id }, body: { reason: reason.trim() } })
      .then(onChange)
      .catch(() => undefined);
  };
  return (
    <li aria-labelledby={`recommendation-${recommendation.id}`}>
      <div className="row-text">
        <span className="row-title" id={`recommendation-${recommendation.id}`}>
          Recommendation for{' '}
          <PersonName personId={recommendation.participantPersonId} names={names} />
        </span>
        <StatusBadge tone={badge.tone} label={`Recommendation ${badge.label}`} />
        <span>Suitability: {recommendation.suitability}</span>
        {recommendation.sharedAt ? (
          <span className="caption">
            Shared with the family {formatInstant(recommendation.sharedAt)}
          </span>
        ) : (
          <span className="caption">Not visible to the family until shared.</span>
        )}
        <EligibilitySummary recommendation={recommendation} />
      </div>
      {recommendation.status === 'withdrawn' ? null : (
        <div className="form">
          <div className="actions">
            {recommendation.status === 'draft' && canShare ? (
              <CommandButton busy={share.isProcessing} onClick={doShare}>
                Share with the family
              </CommandButton>
            ) : null}
            <Button
              variant="secondary"
              aria-expanded={withdrawing}
              onClick={() => setWithdrawing((w) => !w)}
            >
              Withdraw
            </Button>
          </div>
          {withdrawing ? (
            <form
              className="form"
              noValidate
              aria-label="Withdraw the recommendation"
              onSubmit={(event) => {
                event.preventDefault();
                doWithdraw();
              }}
            >
              <TextAreaField
                label="Reason"
                required
                value={reason}
                onChange={setReason}
                error={error}
              />
              <CommandButton type="submit" variant="secondary" busy={withdraw.isProcessing}>
                Withdraw the recommendation
              </CommandButton>
            </form>
          ) : null}
          <CommandError error={share.error} onRetry={doShare} />
          <CommandError error={withdraw.error} onRetry={doWithdraw} />
        </div>
      )}
    </li>
  );
}

const PAGE_SIZE = 50;

/** The published offerings or active programs to recommend, a page at a time (§4.5). */
function TargetChoice({
  target,
  fromOfferingId,
  value,
  onChange,
  error,
}: {
  target: 'offering' | 'program';
  fromOfferingId: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const offerings = useApiPages({
    path: '/offerings',
    request: { query: { limit: PAGE_SIZE } },
    enabled: target === 'offering',
    staleTime: 5 * 60_000,
  });
  const programs = useApiPages({
    path: '/programs',
    request: { query: { status: 'active', limit: PAGE_SIZE } },
    enabled: target === 'program',
    staleTime: 5 * 60_000,
  });
  const what = target === 'offering' ? 'offerings' : 'programs';
  const options =
    target === 'offering'
      ? (offerings.data ?? [])
          .filter((o) => o.id !== fromOfferingId)
          .map((o) => ({ value: o.id, label: o.name }))
      : (programs.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const pages = target === 'offering' ? offerings : programs;
  return (
    <div className="field">
      <SelectField
        label={target === 'offering' ? 'Recommended offering' : 'Recommended program'}
        required
        value={value}
        onChange={onChange}
        options={options}
        error={error}
        hint={
          pages.data === undefined && !pages.error
            ? `Loading ${what}…`
            : pages.data && options.length === 0 && !pages.hasNextPage
              ? target === 'offering'
                ? 'No other published offering to recommend.'
                : 'No active program to recommend.'
              : target === 'offering'
                ? 'Published offerings; the child’s current offering is not listed.'
                : 'Active programs.'
        }
      />
      {pages.error && pages.data === undefined ? (
        <StateView variant="error" error={pages.error} onRetry={() => void pages.refetch()} />
      ) : null}
      <LoadMore pages={pages} label={what} />
    </div>
  );
}

export function ProgressionRecommendations({
  offeringId,
  childIds,
  names,
}: {
  /** The offering the children are enrolled in (`fromOfferingId`). */
  offeringId: string;
  childIds: readonly string[];
  names: PersonNames;
}) {
  const permissions = usePermissions();
  const enabled = permissions.isCapabilityEnabled('youth_progression') === true;
  const create = useApiCommand('post', '/progression-recommendations');
  const [participant, setParticipant] = useState('');
  const [target, setTarget] = useState<'' | 'offering' | 'program'>('');
  const [recommendedId, setRecommendedId] = useState('');
  const [suitability, setSuitability] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Kept outside the capability gate: a switch turning off never hides what can be withdrawn.
  const [made, setMade] = useState<Recommendation[]>([]);

  const childOptions = childIds.map((id) => ({
    value: id,
    label: names.get(id)?.displayName ?? 'A child (name not available)',
  }));

  const submit = () => {
    const next: Record<string, string> = {};
    if (!participant) next.participant = 'Choose the child.';
    if (!target) next.target = 'Choose whether you recommend an offering or a program.';
    else if (!recommendedId)
      next.recommendedId = target === 'offering' ? 'Choose the offering.' : 'Choose the program.';
    if (!suitability.trim()) next.suitability = 'Explain why the next step suits the child.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void create
      .submit({
        body: {
          participantPersonId: participant,
          fromOfferingId: offeringId,
          suitability: suitability.trim(),
          ...(target === 'offering'
            ? { recommendedOfferingId: recommendedId }
            : { recommendedProgramId: recommendedId }),
        },
      })
      .then((recommendation) => {
        setMade((list) => [recommendation, ...list]);
        setParticipant('');
        setTarget('');
        setRecommendedId('');
        setSuitability('');
      })
      .catch(() => undefined);
  };

  return (
    <>
      <CapabilityGate
        capability="youth_progression"
        subject="Progression recommendations"
        whenOff="notice"
        stillAvailable="Recommendations made on this page stay listed and can still be withdrawn."
      >
        {enabled ? (
          <form
            className="form"
            noValidate
            aria-label="Draft a progression recommendation"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <SelectField
              label="Child"
              required
              value={participant}
              onChange={setParticipant}
              options={childOptions}
              error={errors.participant}
              hint={
                childOptions.length === 0 ? 'No enrolled child is listed on this page.' : undefined
              }
            />
            <SelectField
              label="Recommend"
              required
              value={target}
              onChange={(v) => {
                setTarget(v as '' | 'offering' | 'program');
                setRecommendedId('');
              }}
              options={[
                { value: 'offering', label: 'An offering' },
                { value: 'program', label: 'A program' },
              ]}
              error={errors.target}
            />
            {target ? (
              <TargetChoice
                target={target}
                fromOfferingId={offeringId}
                value={recommendedId}
                onChange={setRecommendedId}
                error={errors.recommendedId}
              />
            ) : null}
            <TextAreaField
              label="Suitability"
              required
              value={suitability}
              onChange={setSuitability}
              error={errors.suitability}
              hint="From approved information only. A recommendation never guarantees acceptance, a place or a purchase."
            />
            <CommandButton type="submit" busy={create.isProcessing}>
              Draft the recommendation
            </CommandButton>
            {create.status === 'success' && create.data ? (
              <SuccessNote>{`Recommendation ${create.data.status}`}</SuccessNote>
            ) : null}
            <CommandError error={create.error} onRetry={submit} />
          </form>
        ) : null}
      </CapabilityGate>
      {made.length > 0 ? (
        <ul className="list" aria-label="Recommendations made here">
          {made.map((recommendation) => (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              names={names}
              canShare={enabled}
              onChange={(next) => setMade((list) => list.map((r) => (r.id === next.id ? next : r)))}
            />
          ))}
        </ul>
      ) : null}
      <p className="caption">
        Earlier recommendations cannot be listed here: the API has no staff read of a participant’s
        recommendations yet. Families see shared ones in their app.
      </p>
    </>
  );
}
