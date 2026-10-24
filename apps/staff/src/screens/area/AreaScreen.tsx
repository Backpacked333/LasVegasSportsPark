/**
 * One SPK-UX-005 navigation area that is not built yet: names the screens it will hold (inventory
 * section 5). Each screen group replaces this with its screens and renders the API's ACCESS_DENIED
 * as "not available".
 */
import { Link } from 'react-router';
import type { StaffArea } from '../../navigation/areas';
import { Placeholder } from '../../ui/Placeholder';

export function AreaScreen({ area }: { area: StaffArea }) {
  return (
    <section aria-labelledby={`area-${area.id}`}>
      <h2 id={`area-${area.id}`}>{area.title}</h2>
      {area.links && area.links.length > 0 ? (
        <nav aria-label={`${area.title} screens`}>
          <ul>
            {area.links.map((link) => (
              <li key={link.path}>
                <Link to={link.path}>{link.title}</Link>{' '}
                <span className="caption">({link.screenIds})</span>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <Placeholder screenIds={area.screenIds} title={area.title} purpose={area.purpose} />
    </section>
  );
}
