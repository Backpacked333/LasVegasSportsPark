/**
 * Staff S 3c: the desk tablet handed to the parent to sign a waiver (SPK-REG-011, proposed
 * amendment PA-01; SPK-REG-009). The same form as the parent app's sign sheet (mobile 2c), at
 * tablet size with a finger signature.
 *
 * - It covers the whole screen: the navigation rail and every staff action are hidden, and keys
 *   pressed here never reach the dashboard's shortcuts, so a parent cannot wander into desk tools.
 * - The waiver is the approved version the blocking check names (`GET /v1/policy-versions/{id}`);
 *   the signer is the adult who may complete forms for the child (`useSigners`). Staff never sign.
 * - "Also sign for Maya" is offered only when a sibling in the household has the same waiver
 *   family missing or lapsed and the same adult may sign for them. One ending soon is not
 *   offered: the API renews an acceptance only once it has lapsed (one active acceptance per
 *   version), so "her waiver ends on Dec 3" waits until it ends.
 * - Signing records one digital acceptance per person (`POST /v1/waiver-acceptances`, its own
 *   intent each), with the evidence of the desk tablet and the signature's strokes. A partial
 *   success names who was signed. Then: "Thanks, Dana. Please hand the tablet back." and staff tap
 *   to return to the desk, which re-checks the verdict by itself.
 * - "Hand back without signing" returns with the verdict unchanged.
 */
import type { Schema } from '@sportspark/api-client';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useApiQuery } from '../../../api/useApiQuery';
import { useKeyedCommands } from '../../../features/operations/commands';
import { CommandError } from '../../../features/operations/feedback';
import { useSigners, waiverText } from '../../../features/waivers/WaiverAcceptanceForm';
import { PERSON_WAIVERS_KEY } from '../../../features/waivers/WaiverAcceptanceForm';
import { Icon } from '../../../ui/Icon';
import { DeskAvatar } from './DeskAvatar';
import {
  deskClock,
  fullName,
  type ArrivalIssue,
  type ScanActivity,
  type ScanPerson,
} from './deskModel';

type PersonWaivers = Schema<'PersonWaivers'>;

export interface SignRequest {
  person: ScanPerson;
  activity: ScanActivity;
  issue: ArrivalIssue;
  /** The household's other people: a sibling may be signed for at the same time. */
  household: ScanPerson[];
}

export function TabletSign({
  request,
  timezone,
  onSigned,
  onHandBack,
}: {
  request: SignRequest;
  timezone: string | null;
  /** Staff took the tablet back after a signature: the desk re-checks the verdict. */
  onSigned: (signedIds: string[]) => void;
  /** Closed without signing: the verdict stays as it was. */
  onHandBack: () => void;
}) {
  const { person, activity, issue, household } = request;
  const policyVersionId = issue.reference?.id ?? '';
  const policy = useApiQuery({
    path: '/policy-versions/{id}',
    request: { path: { id: policyVersionId } },
    enabled: policyVersionId !== '',
  });
  const { signers, loaded } = useSigners(person.personId);
  // The adult signing: one of the scanned household who may complete forms for the child.
  const adults = household.filter((p) => p.kind === 'adult');
  const signerId =
    signers.find((s) => adults.some((a) => a.personId === s.value))?.value ??
    signers[0]?.value ??
    null;
  const signer = household.find((p) => p.personId === signerId) ?? null;
  const signerName = signer ? fullName(signer) : (signers[0]?.label ?? 'The parent');
  const signerGiven = signer?.givenName ?? signerName.split(' ')[0] ?? 'there';

  const commands = useKeyedCommands({
    invalidate: [PERSON_WAIVERS_KEY, ['api', '/acknowledgments']],
  });
  const [also, setAlso] = useState(true);
  const [strokes, setStrokes] = useState<string[]>([]);
  const [typed, setTyped] = useState<string | null>(null);
  const [signedIds, setSignedIds] = useState<string[] | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.focus();
  }, []);

  const siblings = household.filter((p) => p.personId !== person.personId && p.kind === 'child');
  // Only a waiver family can be signed for a sibling at the same time (a form is per offering).
  const sibling = useSiblingToSign(
    siblings,
    policy.data?.kind === 'waiver' ? policy.data.key : null,
    signerId,
  );
  const forIds = [person.personId, ...(sibling && also ? [sibling.person.personId] : [])];
  const forNames = [person, ...(sibling && also ? [sibling.person] : [])].map((p) => p.givenName);
  const signed = strokes.length > 0 || (typed !== null && typed.trim().length >= 3);
  const text = policy.data ? waiverText(policy.data.content) : null;
  const renewMonths = (
    policy.data?.content as { renewal?: { renewEveryMonths?: number | null } } | undefined
  )?.renewal?.renewEveryMonths;

  const submit = async () => {
    if (!policy.data || !signerId || !signed) return;
    const done: string[] = [];
    for (const subjectId of forIds) {
      const already = commands.outcome(subjectId).status === 'success';
      if (already) {
        done.push(subjectId);
        continue;
      }
      const evidence = {
        method: 'desk_tablet',
        signerPresent: true,
        signature:
          typed !== null
            ? { kind: 'typed', name: typed.trim() }
            : {
                kind: 'finger',
                strokes: strokes.length,
                path: strokes.join(' ').slice(0, 8000),
              },
      };
      // A required form is an acknowledgment of its version (SPK-REG-009); a waiver is an
      // acceptance of its family (SPK-REG-011). Either way the signer is named, never staff.
      const result =
        issue.code === 'missing_acknowledgment'
          ? await commands.run(subjectId, 'post', '/acknowledgments', {
              body: {
                subjectPersonId: subjectId,
                policyVersionId,
                signedByPersonId: signerId,
                evidence,
              },
            })
          : await commands.run(subjectId, 'post', '/waiver-acceptances', {
              body: {
                subjectPersonId: subjectId,
                policyKey: policy.data.key,
                ...(subjectId === person.personId ? { policyVersionId } : {}),
                method: 'digital',
                signedByPersonId: signerId,
                evidence,
              },
            });
      if (result) done.push(subjectId);
    }
    if (done.length === forIds.length) setSignedIds(done);
  };

  const failedFor = forIds.filter((id) => commands.outcome(id).status === 'error');
  const okFor = forIds.filter((id) => commands.outcome(id).status === 'success');
  const label = `Sign for ${forNames.join(' and ')}`;

  return (
    <div
      className="tablet-sign"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tablet-sign-title"
      tabIndex={-1}
      ref={root}
      // Keys pressed while the parent holds the tablet never reach the staff shortcuts.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className="tablet-sign-bar">
        <span className="tablet-sign-logo" aria-hidden="true">
          <Icon name="sports_soccer" filled />
        </span>
        <b>Sportspark · sign a form</b>
        <span className="tablet-sign-note">Staff tools are hidden while you sign</span>
      </header>
      {signedIds ? (
        <div className="tablet-sign-thanks">
          <Icon name="check_circle" size={56} />
          <h1 id="tablet-sign-title">Thanks, {signerGiven}. Please hand the tablet back.</h1>
          <button
            type="button"
            className="button button-primary tablet-sign-return"
            onClick={() => onSigned(signedIds)}
          >
            Staff: back to the desk
          </button>
        </div>
      ) : (
        <div className="tablet-sign-body">
          <section className="tablet-sign-form" aria-label="The form">
            <div className="tablet-sign-head">
              <DeskAvatar personId={person.personId} name={fullName(person)} size={56} />
              <span>
                <span className="caption">
                  For {fullName(person)} · needed before {activity.title} at{' '}
                  {deskClock(activity.scheduledStart, timezone)}
                </span>
                <h1 id="tablet-sign-title">{policy.data?.title ?? 'Liability waiver'}</h1>
              </span>
            </div>
            {policy.error ? (
              <div className="tablet-sign-error" role="alert">
                Couldn&apos;t load the form. Try again.
                <button type="button" onClick={() => void policy.refetch()}>
                  Try again
                </button>
                <span className="caption">Code {policy.error.code}</span>
              </div>
            ) : text ? (
              <>
                <div className="tablet-sign-short">
                  <b>In short</b>
                  <p>
                    {firstSentence(text)}
                    {renewMonths ? ` Valid for ${renewMonths} months.` : ''}
                  </p>
                </div>
                <div className="tablet-sign-text" tabIndex={0} aria-label="Full text of the form">
                  {text}
                </div>
              </>
            ) : (
              <div className="tablet-sign-text desk-skeleton-block" aria-busy="true">
                Loading the form…
              </div>
            )}
          </section>
          <aside className="tablet-sign-side">
            <div className="tablet-sign-pad-card">
              {typed === null ? (
                <>
                  <span className="caption" id="tablet-pad-label">
                    Sign with your finger
                  </span>
                  <SignaturePad
                    strokes={strokes}
                    onChange={setStrokes}
                    labelledBy="tablet-pad-label"
                    signerLine={`${signerName} · parent`}
                  />
                  <button type="button" className="desk-text-button" onClick={() => setTyped('')}>
                    Type your name instead
                  </button>
                </>
              ) : (
                <label className="tablet-sign-typed">
                  <span className="caption">Type your full name to sign</span>
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="name"
                  />
                  <button type="button" className="desk-text-button" onClick={() => setTyped(null)}>
                    Sign with your finger instead
                  </button>
                </label>
              )}
              {sibling ? (
                <label className="tablet-sign-also">
                  <input
                    type="checkbox"
                    checked={also}
                    onChange={(e) => setAlso(e.target.checked)}
                  />
                  <span>
                    Also sign for <b>{sibling.person.givenName}</b>. {sibling.why}
                  </span>
                </label>
              ) : null}
            </div>
            {!loaded ? null : signerId === null ? (
              <p className="tablet-sign-error" role="alert">
                Nobody here may sign this form for {person.givenName}. Please hand the tablet back.
              </p>
            ) : null}
            <button
              type="button"
              className="button button-primary tablet-sign-primary"
              disabled={!signed || !policy.data || !signerId || commands.anyPending}
              aria-busy={commands.anyPending || undefined}
              onClick={() => void submit()}
            >
              {commands.anyPending ? <span className="button-spinner" aria-hidden="true" /> : null}
              {signed ? label : 'Sign above to continue'}
            </button>
            <button
              type="button"
              className="button button-secondary tablet-sign-back"
              onClick={onHandBack}
            >
              Hand back without signing
            </button>
            {okFor.length > 0 && failedFor.length > 0 ? (
              <p className="tablet-sign-partial" role="status">
                Signed for{' '}
                {household
                  .filter((p) => okFor.includes(p.personId))
                  .map((p) => p.givenName)
                  .join(' and ')}
                . Not saved for the others yet.
              </p>
            ) : null}
            {failedFor.map((id) => {
              const error = commands.outcome(id).error;
              return error ? (
                <CommandError
                  key={id}
                  error={error}
                  onRetry={() => void submit()}
                  subject="This signature"
                />
              ) : null;
            })}
            <p className="caption tablet-sign-foot">
              Recorded for {signerName} with this tablet and the time.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}

/** The form in a line: its numbered headings when it has them, else its first sentence. */
function firstSentence(text: string): string {
  const headings = [...text.matchAll(/(?:^|\n)\s*\d+\.\s*([^.\n]{3,60})\./g)].map((m) =>
    (m[1] ?? '').trim(),
  );
  if (headings.length > 1) return `${headings.join(' · ')}.`;
  const match = /^(.{12,}?[.!?])(\s|$)/.exec(text.trim());
  return match?.[1] ?? text.trim().slice(0, 200);
}

/**
 * A sibling the same adult may sign the same waiver for, when theirs is missing or lapsed
 * (mobile 2c "Also sign for Maya").
 */
function useSiblingToSign(
  siblings: ScanPerson[],
  policyKey: string | null,
  signerId: string | null,
): { person: ScanPerson; why: string } | null {
  const candidate = siblings[0] ?? null;
  const waivers = useApiQuery({
    path: '/people/{id}/waivers',
    request: { path: { id: candidate?.personId ?? '' } },
    enabled: candidate !== null && policyKey !== null,
  });
  const { signers } = useSigners(candidate?.personId ?? '');
  return useMemo(() => {
    if (!candidate || !policyKey || !signerId) return null;
    if (!signers.some((s) => s.value === signerId)) return null;
    const data = waivers.data as PersonWaivers | undefined;
    const waiver = data?.waivers.find((w) => w.policyKey === policyKey);
    if (!waiver) return null;
    // Only a missing or lapsed acceptance can be signed again (a current one is renewed once it
    // lapses: the API refuses a second active acceptance of the same version).
    if (waiver.status === 'missing') return { person: candidate, why: 'It is not signed yet.' };
    if (waiver.status === 'lapsed') {
      const day = waiver.lapsedAt
        ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
            new Date(waiver.lapsedAt),
          )
        : null;
      return { person: candidate, why: day ? `Their waiver ended on ${day}.` : 'It has expired.' };
    }
    return null;
  }, [candidate, policyKey, signerId, signers, waivers.data]);
}

/** A finger (or mouse) signature drawn as SVG strokes; a stroke is one SVG path. */
function SignaturePad({
  strokes,
  onChange,
  labelledBy,
  signerLine,
}: {
  strokes: string[];
  onChange: (strokes: string[]) => void;
  labelledBy: string;
  signerLine: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drawing = useRef<string | null>(null);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    const x = box ? Math.round(event.clientX - box.left) : 0;
    const y = box ? Math.round(event.clientY - box.top) : 0;
    return `${x} ${y}`;
  };
  return (
    <div className="signature-pad">
      <svg
        ref={svg}
        role="img"
        aria-labelledby={labelledBy}
        aria-description={strokes.length > 0 ? 'Signed' : 'Not signed yet'}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drawing.current = `M${point(event)}`;
          onChange([...strokes, drawing.current]);
        }}
        onPointerMove={(event) => {
          if (drawing.current === null) return;
          drawing.current = `${drawing.current} L${point(event)}`;
          onChange([...strokes.slice(0, -1), drawing.current]);
        }}
        onPointerUp={() => {
          drawing.current = null;
        }}
      >
        {strokes.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
      <span className="signature-line">
        <span>{signerLine}</span>
        <button type="button" className="desk-text-button" onClick={() => onChange([])}>
          Clear
        </button>
      </span>
    </div>
  );
}
