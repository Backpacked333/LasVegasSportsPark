/**
 * The decision rail of the registrations triage (handoff S 1c; SPK-REG-002, SPK-REG-003,
 * SPK-REG-005, SPK-REG-007): the reason, the places and the outstanding forms together, so the
 * decision is made where the facts are.
 *
 * - Reason: the first eligibility reason in a plain sentence (`triage-model.reasonChip`).
 * - Places: the offering's capacity pools (`GET /v1/capacity-pools`: confirmed, held, left) and the
 *   families waiting (`GET /v1/waitlist-entries`, status waiting). A read the viewer may not make
 *   is left out.
 * - Forms: each required waiver of the offering (`GET /v1/offerings/{id}/required-waivers`) with
 *   the participant's state (`GET /v1/people/{id}/waivers`).
 * - Decision: Approve (as an exception when eligibility failed; the override and the acceptance
 *   are each audited with the reason), Offer the alternative the API names, Decline (S 3f). Shown
 *   disabled with the reason to a role that may not decide; the API decides in every case.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiQuery } from '../../api/useApiQuery';
import { PersonName } from '../../features/registration-finance/names';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';
import { STATUS_GLYPHS } from '../../ui/StatusBadge';
import { longDate, needsOverride, shortDate, type ReasonChip } from './triage-model';
import type { Alternative } from './DeclineDialog';

type Application = Schema<'Application'>;
type Person = Schema<'PersonDetail'>;
type Offering = Schema<'Offering'>;

function Places({ offering }: { offering: Offering }) {
  const pools = useApiQuery({
    path: '/capacity-pools',
    request: { query: { offeringId: offering.id } },
  });
  const waiting = useApiQuery({
    path: '/waitlist-entries',
    request: { query: { offeringId: offering.id, status: 'waiting' } },
  });
  const pool = (pools.data ?? []).find((p) => p.scopeType === 'offering') ?? pools.data?.[0];
  if (!pool) return null;
  const total = Math.max(1, pool.capacity);
  const parts = [
    `${pool.committed} confirmed`,
    pool.held > 0 ? `${pool.held} held` : null,
    `${Math.max(0, pool.available)} place${pool.available === 1 ? '' : 's'} left`,
    waiting.data ? `${waiting.data.length} on the waitlist` : null,
  ].filter(Boolean);
  return (
    <div className="tri-places">
      <span className="tri-places-name">
        {offering.name}
        {offering.startsOn ? ` · starts ${shortDate(offering.startsOn)}` : ''}
      </span>
      <span
        className="tri-bar"
        role="img"
        aria-label={`${pool.committed} of ${pool.capacity} places taken`}
      >
        <i style={{ width: `${(pool.committed / total) * 100}%` }} />
        <i data-held style={{ width: `${(pool.held / total) * 100}%` }} />
      </span>
      <span className="caption">{parts.join(' · ')}</span>
    </div>
  );
}

function Forms({ offeringId, personId }: { offeringId: string; personId: string }) {
  const required = useApiQuery({
    path: '/offerings/{id}/required-waivers',
    request: { path: { id: offeringId } },
  });
  const mine = useApiQuery({ path: '/people/{id}/waivers', request: { path: { id: personId } } });
  const list = required.data?.waivers ?? [];
  if (list.length === 0) return null;
  return (
    <ul className="tl-checks tri-forms" aria-label="Forms">
      {list.map((w) => {
        const state = mine.data?.waivers.find((x) => x.policyKey === w.policyKey);
        const signed = state?.status === 'current';
        const tone = !mine.data ? 'pending' : signed ? 'success' : 'danger';
        return (
          <li key={w.policyKey} data-tone={tone}>
            <span>{state?.title ?? w.policyKey.replaceAll('_', ' ').replaceAll('-', ' ')}</span>
            <b>
              <span aria-hidden="true">{STATUS_GLYPHS[tone]}</span>{' '}
              {!mine.data ? 'Not known' : signed ? 'Signed' : 'Not signed'}
            </b>
          </li>
        );
      })}
    </ul>
  );
}

export function TriageRail({
  application,
  person,
  offering,
  chips,
  alternative,
  mayDecide,
  online,
  onApprove,
  onOffer,
  onDecline,
}: {
  application: Application;
  person: Person | undefined;
  offering: Offering | undefined;
  chips: readonly ReasonChip[];
  alternative: Alternative | null;
  mayDecide: boolean;
  online: boolean;
  onApprove: () => void;
  onOffer: () => void;
  onDecline: () => void;
}) {
  const name = person ? `${person.givenName} ${person.familyName}` : 'Participant';
  const reason = chips[0];
  const parent = application.submittedByPersonId;
  const exception = needsOverride(application);
  const disabled = !mayDecide || !online;
  return (
    <aside className="card tri-rail" aria-label={`Decision for ${name}`}>
      <div className="tri-rail-head">
        <Avatar name={name} personKey={application.participantPersonId} size={48} decorative />
        <span className="tri-rail-who">
          <h3>{name}</h3>
          <span className="caption">
            {person?.dateOfBirth ? `Born ${longDate(person.dateOfBirth)}` : 'No date of birth'}
            {parent && parent !== application.participantPersonId ? (
              <>
                {' · applied by '}
                <PersonName id={parent} fallback="a family member" />
              </>
            ) : null}
          </span>
        </span>
        <Link className="tri-record" to={`/people/${application.participantPersonId}`}>
          Record →
        </Link>
      </div>
      {reason ? (
        <div className="tri-reason" data-tone={reason.tone}>
          <b>
            <span aria-hidden="true">{STATUS_GLYPHS[reason.tone]}</span> {reason.title}
          </b>
          <span>{reason.sentence}</span>
          {chips.slice(1).map((c) => (
            <span key={c.code} className="caption">
              <span aria-hidden="true">{STATUS_GLYPHS[c.tone]}</span> {c.text}
            </span>
          ))}
        </div>
      ) : null}
      {offering ? <Places offering={offering} /> : null}
      <Forms offeringId={application.offeringId} personId={application.participantPersonId} />
      {application.notes ? <p className="caption tri-notes">“{application.notes}”</p> : null}
      <div className="tri-decide">
        <span className="caption">Decision · recorded with your name and reason</span>
        <Button className="tri-approve" disabled={disabled} onClick={onApprove}>
          {exception ? 'Approve as an exception' : 'Approve'}
          <kbd aria-hidden="true">A</kbd>
        </Button>
        <div className="tri-pair">
          {alternative ? (
            <Button variant="secondary" disabled={disabled} onClick={onOffer}>
              Offer {alternative.name}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            className="button-danger-outline"
            disabled={disabled}
            onClick={onDecline}
          >
            Decline
          </Button>
        </div>
        {!mayDecide ? (
          <p className="caption">
            Deciding needs a program, league or general manager (enrollment.review_application).
          </p>
        ) : !online ? (
          <p className="caption">Deciding needs a connection.</p>
        ) : null}
      </div>
    </aside>
  );
}
