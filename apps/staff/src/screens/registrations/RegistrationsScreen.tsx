/**
 * "Registrations and waitlists" area home (SPK-UX-005): what is waiting for a decision right now
 * (the API's two waiting application states, `GET /v1/applications`, first page each, newest
 * first) and the four screens of the area, SCR-S-24 to SCR-S-27, with what each is for. The
 * preview is read-only: decisions are made in the queue (SCR-S-24) with their reasons. Visibility
 * of each screen's records is decided by the API; a list the viewer may not read is said so here
 * without hiding the rest of the page.
 */
import { formatAge, presentationForError } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import '../../features/grow/grow.css';
import {
  APPLICATION_STATUS,
  REGISTRATION_INTENT,
} from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { Icon, type IconName } from '../../ui/Icon';
import { PageHeader } from '../../ui/Page';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import './registrations.css';

const SCREENS: readonly {
  to: string;
  title: string;
  id: string;
  icon: IconName;
  purpose: string;
}[] = [
  {
    to: '/registrations/queue',
    title: 'Registration queue and approvals',
    id: 'SCR-S-24',
    icon: 'how_to_reg',
    purpose:
      'Applications awaiting review with their eligibility reasons; approve, decline, or override an eligibility failure with a reason.',
  },
  {
    to: '/registrations/assisted',
    title: 'Assisted registration',
    id: 'SCR-S-25',
    icon: 'person_add',
    purpose:
      'Register on behalf of a household with the same basket, eligibility, quote and checkout commands customers use.',
  },
  {
    to: '/registrations/waitlists',
    title: 'Waitlist management',
    id: 'SCR-S-26',
    icon: 'hourglass_empty',
    purpose:
      'Waitlist entries with priority basis, preferences, status and offer history; offer a free place to the next entry.',
  },
  {
    to: '/registrations/enrollments',
    title: 'Cancellation and transfer',
    id: 'SCR-S-27',
    icon: 'event_repeat',
    purpose:
      'Preview and commit cancellations and transfers with dates, capacity and the accepted financial consequence; membership suspensions and session package corrections.',
  },
];

const PREVIEW = 5;

function WaitingPreview() {
  const now = useNow();
  const awaiting = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: 'awaiting_review' } },
  });
  const submitted = useApiPages({
    path: '/applications',
    request: { query: { limit: 50, status: 'submitted' } },
  });
  const failed = [awaiting.error, submitted.error].find((e) => e !== null) ?? null;
  const loaded = awaiting.data !== undefined && submitted.data !== undefined;
  const items = [...(submitted.data ?? []), ...(awaiting.data ?? [])];
  const more = awaiting.hasNextPage || submitted.hasNextPage;
  let body;
  if (!loaded && failed) {
    body = (
      <p className="caption">
        {presentationForError(failed) === 'unavailable'
          ? 'Applications are not available to you.'
          : `Applications could not load (${failed.code}). Open the queue to try again.`}
      </p>
    );
  } else if (!loaded) {
    body = <p className="caption">Loading applications…</p>;
  } else if (items.length === 0) {
    body = (
      <StateView
        variant="empty"
        title="Queue clear"
        description="No application is waiting for a decision."
      />
    );
  } else {
    body = (
      <ul className="list approvals" aria-label="Waiting for a decision">
        {items.slice(0, PREVIEW).map((a) => {
          const failedEligibility = a.eligibility !== null && !a.eligibility.eligible;
          return (
            <li key={a.id} className="approval" data-tone={failedEligibility ? 'danger' : 'info'}>
              <span
                className="icon-tile"
                data-tone={failedEligibility ? 'danger' : 'info'}
                aria-hidden="true"
              >
                <Icon name={failedEligibility ? 'rule' : 'how_to_reg'} size={20} />
              </span>
              <div className="row-text">
                <span className="type-caps">{REGISTRATION_INTENT[a.intent]}</span>
                <span className="row-title">
                  <PersonName id={a.participantPersonId} fallback="Participant" />
                  <span className="approval-arrow"> → </span>
                  <OfferingName id={a.offeringId} />
                </span>
                <span className="caption">
                  submitted {a.submittedAt ? formatAge(new Date(a.submittedAt), now) : 'not yet'}
                  {failedEligibility ? ' · eligibility not met' : ''}
                </span>
              </div>
              <span className="rf-actions">
                <StatusBadge {...APPLICATION_STATUS[a.status]} />
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section className="card card-flush queue-card" aria-labelledby="waiting-title">
      <div className="card-head">
        <h3 id="waiting-title">Needs a decision</h3>
        {loaded ? (
          <span className="queue-count">
            {items.length}
            {more ? '+' : ''} waiting
          </span>
        ) : null}
      </div>
      <div className="queue-note">{body}</div>
      <div className="card-foot">
        <Link to="/registrations/queue">
          {loaded && items.length > PREVIEW
            ? `Open the queue for all ${items.length}${more ? '+' : ''} →`
            : 'Open the queue →'}
        </Link>
      </div>
    </section>
  );
}

export function RegistrationsScreen() {
  return (
    <section aria-labelledby="registrations-title" className="grow">
      <PageHeader
        eyebrow="Grow · Approvals, waitlists and changes"
        title="Registrations and waitlists"
        titleId="registrations-title"
        actions={
          <Link className="button button-primary" to="/registrations/assisted">
            <Icon name="person_add" size={19} />
            Register someone at the desk
          </Link>
        }
      />
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <div className="split">
        <div className="split-main">
          <WaitingPreview />
        </div>
        <div className="split-side">
          <section className="card card-flush" aria-labelledby="reg-screens-title">
            <div className="card-head">
              <h4 id="reg-screens-title">In this area</h4>
            </div>
            <ul className="list reg-screens" aria-label="Registration screens">
              {SCREENS.map((screen) => (
                <li key={screen.id}>
                  <span className="icon-tile" data-tone="success" aria-hidden="true">
                    <Icon name={screen.icon} size={20} />
                  </span>
                  <div className="row-text">
                    <Link className="row-title" to={screen.to}>
                      {screen.title}
                    </Link>
                    <span className="caption">{screen.purpose}</span>
                    <span className="caption">{screen.id}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
