/**
 * SCR-S-24 Registrations, as the redesign draws it (handoff S 1c triage queue, S 3f decline, S 2c
 * waitlist offers; SPK-REG-002, SPK-REG-003, SPK-REG-005, SPK-REG-007, SPK-REG-008, SPK-UX-005).
 * The rail's Registrations opens here (`/registrations`, also `/registrations/queue`).
 *
 * Tabs with live counts (INTERACTIONS 1c row 1), kept in the address (`?tab=`):
 * - Needs a decision (`TriageQueue`): applications waiting for a person, with the reasons, bulk
 *   decisions, the decision rail and the J/K/X/A/O/D keys.
 * - Waitlist offers (`WaitlistOffersTab`): offers in flight with their time left.
 * - Forms missing: activities whose enrollments miss a required form, from reporting's enrollment
 *   completeness read (`GET /v1/reports/enrollment-completeness`, demand reports: program, league
 *   and general managers), each opening its enrollments.
 * - All: every application by status, newest first (`GET /v1/applications`).
 *
 * Counts come from the same reads (with "+" while more pages exist); a tab the viewer may not read
 * shows no count and says so when opened. Approval comes before any payment and reserves no place
 * unless an approved policy says so (pending DEC-028, DEC-029); who may override eligibility is
 * pending DEC-066 (the API decides; ACCESS_DENIED names the missing permission).
 */
import { useSearchParams, Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { APPLICATION_STATUS } from '../../features/registration-finance/labels';
import { OfferingName, PersonName } from '../../features/registration-finance/names';
import { useApp, useNow } from '../../providers/AppProviders';
import { Icon } from '../../ui/Icon';
import { LoadMore } from '../../ui/LoadMore';
import { PageHeader } from '../../ui/Page';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { TriageQueue, useDecisionPages } from './TriageQueue';
import { WaitlistOffersTab } from './WaitlistOffersTab';
import { waitingLabel } from './triage-model';
import './registrations.css';
import './triage.css';

type Tab = 'decide' | 'offers' | 'forms' | 'all';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'decide', label: 'Needs a decision' },
  { id: 'offers', label: 'Waitlist offers' },
  { id: 'forms', label: 'Forms missing' },
  { id: 'all', label: 'All' },
];

function count(n: number | undefined, more: boolean): string | null {
  if (n === undefined) return null;
  return `${n}${more ? '+' : ''}`;
}

function useFormsMissing(facilityId: string | null) {
  return useApiQuery({
    path: '/reports/enrollment-completeness',
    request: { query: { facilityId: facilityId ?? '' } },
    enabled: !!facilityId,
  });
}

function FormsMissingTab({ facilityId }: { facilityId: string | null }) {
  const report = useFormsMissing(facilityId);
  if (!facilityId) {
    return (
      <StateView
        variant="empty"
        title="Choose a facility"
        description="Forms missing are counted per facility: choose one in the header."
      />
    );
  }
  return (
    <QueryBoundary
      query={report}
      label="forms missing"
      hideAge
      isEmpty={(r) => !r.rows.some((row) => Number(row.enrollmentsMissingForms) > 0)}
      empty={{ title: 'No forms missing', description: 'Every enrollment has its required forms.' }}
    >
      {(r) => (
        <section className="card card-flush wl-card" aria-label="Activities with forms missing">
          <table className="wl-table">
            <thead>
              <tr>
                <th scope="col">Activity</th>
                <th scope="col">Enrollments missing a form</th>
                <th scope="col" className="wl-actions-col">
                  Open
                </th>
              </tr>
            </thead>
            <tbody>
              {r.rows
                .filter((row) => Number(row.enrollmentsMissingForms) > 0)
                .map((row) => (
                  <tr key={String(row.offeringId)}>
                    <td>
                      <b>{String(row.offering ?? 'Activity')}</b>
                    </td>
                    <td>
                      <span className="tri-chip" data-tone="warning">
                        <span aria-hidden="true">▲</span> {String(row.enrollmentsMissingForms)}{' '}
                        missing
                      </span>
                    </td>
                    <td className="wl-actions">
                      <Link
                        className="button button-secondary button-sm"
                        to={`/programs/offerings/${String(row.offeringId)}`}
                      >
                        Open activity
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </QueryBoundary>
  );
}

function AllTab() {
  const now = useNow();
  const pages = useApiPages({ path: '/applications', request: { query: { limit: 50 } } });
  return (
    <section className="card card-flush wl-card" aria-label="All applications">
      <QueryBoundary
        query={pages}
        label="applications"
        hideAge
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No applications', description: 'No application has been made yet.' }}
      >
        {(items) => (
          <table className="wl-table">
            <thead>
              <tr>
                <th scope="col">Participant</th>
                <th scope="col">Activity</th>
                <th scope="col">Status</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <PersonName id={a.participantPersonId} fallback="Participant" />
                  </td>
                  <td>
                    <OfferingName id={a.offeringId} />
                  </td>
                  <td>
                    <StatusBadge {...APPLICATION_STATUS[a.status]} />
                  </td>
                  <td>{waitingLabel(a.submittedAt, now)} ago</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="applications" />
    </section>
  );
}

export function RegistrationQueueScreen() {
  const { facilityId } = useApp();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'decide';
  const { submitted, awaiting } = useDecisionPages();
  const offers = useApiPages({
    path: '/waitlist-queue',
    request: { query: { status: 'offered', limit: 100 } },
  });
  const forms = useFormsMissing(facilityId);
  const decideCount =
    submitted.data && awaiting.data
      ? count(
          submitted.data.length + awaiting.data.length,
          submitted.hasNextPage || awaiting.hasNextPage,
        )
      : null;
  const offerCount = offers.data ? count(offers.data.length, offers.hasNextPage) : null;
  const formsCount = forms.data
    ? String(forms.data.rows.reduce((sum, r) => sum + (Number(r.enrollmentsMissingForms) || 0), 0))
    : null;
  const counts: Record<Tab, string | null> = {
    decide: decideCount,
    offers: offerCount,
    forms: formsCount,
    all: null,
  };
  const eyebrow = [
    decideCount !== null ? `${decideCount} waiting for a decision` : null,
    offerCount !== null ? `${offerCount} offers in flight` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <section aria-labelledby="queue-title" className="grow tri-screen">
      <PageHeader
        eyebrow={eyebrow || 'Registrations and waitlists'}
        title="Registrations"
        titleId="queue-title"
        actions={
          <div className="tri-tabs" role="tablist" aria-label="Registrations">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() =>
                  setParams((p) => {
                    const n = new URLSearchParams(p);
                    if (t.id === 'decide') n.delete('tab');
                    else n.set('tab', t.id);
                    return n;
                  })
                }
              >
                {t.label}
                {counts[t.id] !== null ? (
                  <span className="tri-tab-count" data-tab={t.id}>
                    {counts[t.id]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        }
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'decide' ? <TriageQueue /> : null}
        {tab === 'offers' ? <WaitlistOffersTab /> : null}
        {tab === 'forms' ? <FormsMissingTab facilityId={facilityId} /> : null}
        {tab === 'all' ? <AllTab /> : null}
      </div>
      <nav className="sched-more tri-more" aria-label="Registrations and waitlists">
        <span className="caption">More:</span>
        <Link to="/registrations/assisted">
          <Icon name="person_add" size={16} /> Register someone at the desk
        </Link>
        <Link to="/registrations/waitlists">Waitlists by activity</Link>
        <Link to="/registrations/enrollments">Cancellation and transfer</Link>
      </nav>
    </section>
  );
}
