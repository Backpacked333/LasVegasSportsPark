// Unknown dashboard paths: shown as not available, never followed elsewhere.
import { Link } from 'react-router';
import { Icon } from '../../ui/Icon';
import { StateView } from '../../ui/StateView';
import '../area/area.css';

export function NotFoundScreen() {
  return (
    <section className="area-oob" aria-label="Page not available">
      <div className="area-oob-art" aria-hidden="true">
        <span className="area-oob-flag">
          <Icon name="flag" size={28} filled />
        </span>
        <span className="area-oob-word">Out of bounds</span>
      </div>
      <StateView
        variant="unavailable"
        title="Page not available"
        description="This address does not open anything in the dashboard."
      />
      <Link className="button button-primary" to="/today">
        <Icon name="arrow_back" size={18} />
        Back to Today
      </Link>
    </section>
  );
}
