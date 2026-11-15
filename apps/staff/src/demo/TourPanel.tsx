/**
 * The guided tour for the role being demonstrated: one step per screen, Back and Next move between
 * steps and open each step's screen. Demo builds only.
 */
import { useLocation, useNavigate } from 'react-router';
import { Button } from '../ui/Button';
import { Glass } from '../ui/glass/Glass';
import { demoLinksFromEnv, stepPath, type DemoLinks } from './links';
import { findRole } from './roles';
import { setDemoState, useDemoState } from './store';
import './demo.css';

export function TourPanel({ links = demoLinksFromEnv() }: { links?: DemoLinks }) {
  const demo = useDemoState();
  const navigate = useNavigate();
  const location = useLocation();
  const role = findRole(demo.roleId);
  if (!role || role.tour.length === 0 || !demo.open) return null;

  const last = role.tour.length - 1;
  const index = Math.min(demo.step, last);
  const step = role.tour[index]!;
  // A step opens its seeded record when the demo knows it, otherwise its fallback screen.
  const path = stepPath(step, links);
  const onScreen = location.pathname === path.split('?')[0];
  const open = (step.openLinks ?? []).flatMap((item) => {
    const href = links[item.link];
    return href ? [{ label: item.label, href }] : [];
  });

  const go = (next: number) => {
    const target = role.tour[next];
    if (!target) return;
    setDemoState({ step: next });
    navigate(stepPath(target, links));
  };

  return (
    <Glass
      as="aside"
      radius={24}
      squircle
      material="frost"
      blur={22}
      className="demo-tour"
      aria-labelledby="demo-tour-title"
    >
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
      {open.length > 0 ? (
        <ul className="demo-tour-links">
          {open.map((item) => (
            <li key={item.href}>
              <a href={item.href} target="_blank" rel="noreferrer">
                {item.label} (opens in a new tab, no sign-in)
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {!onScreen ? (
        <Button variant="secondary" onClick={() => navigate(path)}>
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
    </Glass>
  );
}
