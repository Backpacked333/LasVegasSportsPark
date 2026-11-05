/**
 * The guided tour for the role being demonstrated: one step per screen, Back and Next move between
 * steps and open each step's screen. Demo builds only.
 */
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../ui/Button';
import { findRole } from './roles';
import { setDemoState, useDemoState } from './store';

export function TourPanel() {
  const demo = useDemoState();
  const navigate = useNavigate();
  const location = useLocation();
  const role = findRole(demo.roleId);
  if (!role || role.tour.length === 0 || !demo.open) return null;

  const last = role.tour.length - 1;
  const index = Math.min(demo.step, last);
  const step = role.tour[index]!;
  const onScreen = location.pathname === step.path;

  const go = (next: number) => {
    const target = role.tour[next];
    if (!target) return;
    setDemoState({ step: next });
    navigate(target.path);
  };

  return (
    <aside className="demo-tour" aria-labelledby="demo-tour-title">
      <p className="demo-tour-count">
        {role.title} tour · step {index + 1} of {role.tour.length}
      </p>
      <h2 id="demo-tour-title">{step.title}</h2>
      <p>{step.body}</p>
      {step.tryThis && step.tryThis.length > 0 ? (
        <>
          <h3>Try this</h3>
          <ul>
            {step.tryThis.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </>
      ) : null}
      {!onScreen ? (
        <Button variant="secondary" onClick={() => navigate(step.path)}>
          Open this screen
        </Button>
      ) : null}
      <div className="demo-tour-actions">
        <Button variant="secondary" disabled={index === 0} onClick={() => go(index - 1)}>
          Back
        </Button>
        {index < last ? (
          <Button onClick={() => go(index + 1)}>Next</Button>
        ) : (
          <Button onClick={() => setDemoState({ open: false, step: 0 })}>Finish tour</Button>
        )}
      </div>
    </aside>
  );
}
