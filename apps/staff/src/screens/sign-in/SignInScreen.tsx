/**
 * Staff sign-in (§4.13, §4.14 MFA for privileged staff). A build that names an identity provider
 * (`VITE_AUTH_ISSUER`, `VITE_AUTH_CLIENT_ID`) offers managed sign-in (`ManagedSignInPanel`). Which
 * provider that is remains DEC-018 (Technical lead/account owners), so a build that names none
 * shows the pending state. Development builds also offer the development sign-in, which
 * production bundles do not contain.
 *
 * Layout (SPK-UX-010 soccer-specific identity): a night-pitch panel with the park's field markings
 * beside the sign-in card. The pitch is decorative (`aria-hidden`); below 900 px it shrinks to a
 * band above the card so the form stays first on a phone.
 */
import { Suspense } from 'react';
import { useLocation } from 'react-router';
import { DevSignIn } from '../../dev';
import { useApp } from '../../providers/AppProviders';
import { Icon, type IconName } from '../../ui/Icon';
import { StateView } from '../../ui/StateView';
import { ManagedSignInPanel } from './ManagedSignInPanel';
import './sign-in.css';

const SPORTS: readonly { icon: IconName; label: string }[] = [
  { icon: 'sports_soccer', label: 'Soccer' },
  { icon: 'stadium', label: 'Indoor soccer' },
  { icon: 'sports_basketball', label: 'Basketball' },
  { icon: 'school', label: 'Camps' },
  { icon: 'cake', label: 'Parties' },
];

/** Field markings of a full-size pitch, drawn in the floodlight colour at low opacity. */
function PitchMarkings() {
  return (
    <svg
      className="signin-pitch-lines"
      viewBox="0 0 680 1050"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="3">
        <rect x="40" y="40" width="600" height="970" rx="2" />
        <line x1="40" y1="525" x2="640" y2="525" />
        <circle cx="340" cy="525" r="92" />
        <rect x="178" y="40" width="324" height="165" />
        <rect x="258" y="40" width="164" height="55" />
        <path d="M 270 205 A 92 92 0 0 0 410 205" />
        <rect x="178" y="845" width="324" height="165" />
        <rect x="258" y="955" width="164" height="55" />
        <path d="M 270 845 A 92 92 0 0 1 410 845" />
        <path d="M 40 58 A 18 18 0 0 0 58 40" />
        <path d="M 622 40 A 18 18 0 0 0 640 58" />
        <path d="M 40 992 A 18 18 0 0 1 58 1010" />
        <path d="M 622 1010 A 18 18 0 0 1 640 992" />
      </g>
      <g fill="currentColor">
        <circle cx="340" cy="525" r="5" />
        <circle cx="340" cy="150" r="4" />
        <circle cx="340" cy="900" r="4" />
      </g>
    </svg>
  );
}

export function SignInScreen() {
  const location = useLocation();
  const expired = (location.state as { expired?: boolean } | null)?.expired === true;
  const managedSignIn = useApp().services.managedSignIn ?? null;
  return (
    <div className="signin">
      <aside className="signin-pitch" aria-hidden="true">
        <span className="signin-glow signin-glow-a" />
        <span className="signin-glow signin-glow-b" />
        <PitchMarkings />
        <div className="signin-pitch-top">
          <span className="brand-mark">
            <Icon name="sports_soccer" size={22} filled />
          </span>
          <span className="brand-text">
            <span className="brand-kicker">Sportspark</span>
            <span className="brand-name">Park staff</span>
          </span>
        </div>
        <div className="signin-pitch-copy">
          <span className="signin-kicker">
            <span className="live-dot" /> Las Vegas Sports Park
          </span>
          <p className="signin-headline">
            Lights on.
            <br />
            Run the park.
          </p>
          <p className="signin-sub">
            Fields, schedules, leagues, check-in and the money behind them, in one place for the
            people who keep the park running.
          </p>
          <ul className="signin-sports">
            {SPORTS.map((s) => (
              <li key={s.label}>
                <Icon name={s.icon} size={16} />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main id="main" className="shell-main signin-main">
        <div className="signin-card">
          <span className="eyebrow">Staff sign-in</span>
          <h1>Sportspark staff</h1>
          <p className="signin-intro">
            For park staff, coaches and officials. Sign in to open your workspace.
          </p>
          {expired ? (
            <p role="status" className="signin-expired">
              <Icon name="schedule" size={18} />
              Your session ended. Sign in again.
            </p>
          ) : null}
          {managedSignIn ? <ManagedSignInPanel managedSignIn={managedSignIn} /> : null}
          {DevSignIn ? (
            <Suspense fallback={<StateView variant="loading" label="sign-in" />}>
              <DevSignIn />
            </Suspense>
          ) : managedSignIn ? null : (
            <StateView
              variant="pending-decision"
              subject="Staff sign-in"
              decisions={['DEC-018']}
              owner="Technical lead/account owners"
            />
          )}
        </div>
        <p className="signin-foot caption">
          <Icon name="lock" size={14} /> Sessions expire. Sign out when you leave a shared desk
          device.
        </p>
      </main>
    </div>
  );
}
