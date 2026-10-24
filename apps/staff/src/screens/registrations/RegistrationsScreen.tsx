/**
 * "Registrations and waitlists" area home (SPK-UX-005): the four screens of the area, SCR-S-24 to
 * SCR-S-27, with what each is for. Visibility of each screen's records is decided by the API.
 */
import { Link } from 'react-router';
import { REGISTRATION_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';

const SCREENS = [
  {
    to: '/registrations/queue',
    title: 'Registration queue and approvals',
    id: 'SCR-S-24',
    purpose:
      'Applications awaiting review with their eligibility reasons; approve, decline, or override an eligibility failure with a reason.',
  },
  {
    to: '/registrations/assisted',
    title: 'Assisted registration',
    id: 'SCR-S-25',
    purpose:
      'Register on behalf of a household with the same basket, eligibility, quote and checkout commands customers use.',
  },
  {
    to: '/registrations/waitlists',
    title: 'Waitlist management',
    id: 'SCR-S-26',
    purpose: 'Waitlist entries with priority basis, preferences, status and offer history.',
  },
  {
    to: '/registrations/enrollments',
    title: 'Cancellation and transfer',
    id: 'SCR-S-27',
    purpose:
      'Preview and commit cancellations and transfers with dates, capacity and the financial consequence.',
  },
] as const;

export function RegistrationsScreen() {
  return (
    <section aria-labelledby="registrations-title">
      <h2 id="registrations-title">Registrations and waitlists</h2>
      <SectionNav label="Registrations and waitlists" links={REGISTRATION_LINKS} />
      <ul className="list" aria-label="Registration screens">
        {SCREENS.map((screen) => (
          <li key={screen.id}>
            <div className="row-text">
              <Link className="row-title" to={screen.to}>
                {screen.title}
              </Link>
              <span>{screen.purpose}</span>
              <span className="caption">{screen.id}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
