/**
 * "More" of the phone workspace tabs (staff redesign Phase 8): every workspace screen that is not
 * a tab of the viewer's tab bar (coach, referee or field crew, workspace-kind.ts), as plain links
 * with icons and written labels (SPK-UX-009). Opening a screen decides nothing: each one reads
 * the API, which answers for the viewer.
 */
import { Link } from 'react-router';
import { WORKSPACE_PATH } from '../../navigation/areas';
import { Icon, type IconName } from '../../ui/Icon';
import { CrewHero } from './crew-ui';
import { useWorkspaceTabs } from './workspace-kind';
import './crew.css';

const SCREENS: readonly { to: string; label: string; hint: string; icon: IconName }[] = [
  {
    to: `${WORKSPACE_PATH}/week`,
    label: 'My week',
    hint: 'Games and classes',
    icon: 'calendar_month',
  },
  { to: `${WORKSPACE_PATH}/teams`, label: 'Teams', hint: 'The teams you coach', icon: 'groups' },
  {
    to: WORKSPACE_PATH,
    label: 'My assignments',
    hint: 'Answer offers, open an activity',
    icon: 'stadium',
  },
  {
    to: `${WORKSPACE_PATH}/messages`,
    label: 'Team messages',
    hint: 'Threads with families',
    icon: 'forum',
  },
  {
    to: `${WORKSPACE_PATH}/referee`,
    label: 'Referee home',
    hint: 'Requests and games',
    icon: 'sports',
  },
  {
    to: `${WORKSPACE_PATH}/assessments`,
    label: 'Assessments',
    hint: 'Skills at the end of term',
    icon: 'checklist',
  },
  {
    to: `${WORKSPACE_PATH}/fees`,
    label: 'Hours and fees',
    hint: 'Fees and their approval',
    icon: 'payments',
  },
  {
    to: `${WORKSPACE_PATH}/fields`,
    label: 'Fields',
    hint: "Today's field preparation",
    icon: 'grass',
  },
  {
    to: '/facilities/board',
    label: 'Tasks board',
    hint: 'Maintenance to do, doing, done',
    icon: 'handyman',
  },
  {
    to: `${WORKSPACE_PATH}/issues`,
    label: 'Report an injury',
    hint: 'A child hurt in your session',
    icon: 'personal_injury',
  },
  {
    to: `${WORKSPACE_PATH}/report-problem`,
    label: 'Report a problem',
    hint: 'Something broken on a field',
    icon: 'construction',
  },
  {
    to: `${WORKSPACE_PATH}/offline`,
    label: 'Offline queue',
    hint: 'What waits for a connection',
    icon: 'sync',
  },
];

export function WorkspaceMoreScreen() {
  const tabs = useWorkspaceTabs();
  const shown = new Set(tabs.map((t) => t.to));
  const rest = SCREENS.filter((s) => !shown.has(s.to));
  return (
    <section aria-labelledby="ws-more-title" className="crew ops-screen">
      <CrewHero titleId="ws-more-title" kicker="Workspace" title="More" />
      <nav className="crew-card" aria-label="More workspace screens">
        <ul className="crew-list">
          {rest.map((s) => (
            <li key={s.to}>
              <Link className="crew-row crew-link" to={s.to}>
                <Icon name={s.icon} size={22} />
                <span className="crew-row-text">
                  <span className="crew-row-title">{s.label}</span>
                  <span className="crew-meta">{s.hint}</span>
                </span>
                <Icon name="chevron_right" size={20} />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
