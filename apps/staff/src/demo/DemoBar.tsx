/**
 * The demo banner shown on every screen in demo mode: says the data is sample data, names the role
 * being demonstrated, and offers the tour and a role switch. Demo builds only.
 */
import { useNavigate } from 'react-router';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { findRole } from './roles';
import { resetDemoState, setDemoState, useDemoState } from './store';

export function DemoBar() {
  const { signOut } = useApp();
  const navigate = useNavigate();
  const demo = useDemoState();
  const role = findRole(demo.roleId);

  const switchRole = async () => {
    resetDemoState();
    await signOut();
    navigate('/sign-in', { replace: true });
  };

  return (
    <section className="demo-bar" aria-label="Demo mode">
      <p>
        <strong>Demo mode</strong>
        <span> · sample data, nothing here is real</span>
        {role ? <span> · viewing as {role.title.toLowerCase()}</span> : null}
      </p>
      <div className="demo-bar-actions">
        {role && role.tour.length > 0 ? (
          <Button
            variant="secondary"
            aria-expanded={demo.open}
            onClick={() => setDemoState({ open: !demo.open })}
          >
            {demo.open ? 'Hide tour' : 'Show tour'}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => void switchRole()}>
          Switch role
        </Button>
      </div>
    </section>
  );
}
