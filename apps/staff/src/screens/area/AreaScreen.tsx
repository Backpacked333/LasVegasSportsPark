/**
 * One SPK-UX-005 navigation area that is not built yet: names the screens it will hold (inventory
 * section 5). Each screen group replaces this with its screens and renders the API's ACCESS_DENIED
 * as "not available".
 *
 * An area that links built screens (Administration) shows them as a directory of tiles, and for
 * Administration a read-only overview of accounts, capability switches and integrations above it.
 */
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import type { StaffArea } from '../../navigation/areas';
import { Icon, type IconName } from '../../ui/Icon';
import { PageHeader } from '../../ui/Page';
import { Placeholder } from '../../ui/Placeholder';
import { AdminOverview } from '../admin/AdminOverview';
import './area.css';

/** Icons for the linked screens, by path; anything else gets the area's own icon. */
const LINK_ICON: Record<string, IconName> = {
  '/admin/accounts': 'manage_accounts',
  '/admin/audit': 'history',
  '/admin/integrations': 'link',
  '/admin/capabilities': 'tune',
  '/admin/provider-events': 'inbox',
  '/admin/migration': 'upload_file',
  '/support/cases': 'support_agent',
  '/admin/access-hardware': 'qr_code_scanner',
};

export function AreaScreen({ area }: { area: StaffArea }) {
  const permissions = usePermissions();
  const links = (area.links ?? []).filter(
    (link) => !link.actionId || permissions.isPermitted(link.actionId) === true,
  );
  return (
    <section aria-labelledby={`area-${area.id}`} className="area">
      <PageHeader
        eyebrow={`${area.group} · ${area.screenIds}`}
        title={area.title}
        titleId={`area-${area.id}`}
        intro={area.purpose}
        actions={
          area.id === 'admin' ? (
            <Link className="button button-primary" to="/admin/accounts">
              <Icon name="person_add" size={18} />
              Assign staff roles
            </Link>
          ) : null
        }
      />
      {area.id === 'admin' ? <AdminOverview /> : null}
      {links.length > 0 ? (
        <nav aria-label={`${area.title} screens`} className="area-directory">
          <h3 className="area-directory-title">All {area.title.toLowerCase()} screens</h3>
          <ul>
            {links.map((link) => (
              <li key={link.path}>
                <span className="area-tile-icon" aria-hidden="true">
                  <Icon name={LINK_ICON[link.path] ?? area.icon} size={20} />
                </span>
                <span className="area-tile-text">
                  <Link to={link.path}>{link.title}</Link>
                  <span className="label-caps">{link.screenIds}</span>
                </span>
                <span className="area-tile-chevron" aria-hidden="true">
                  <Icon name="chevron_right" size={20} />
                </span>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {links.length > 0 ? (
        // Only what is not built yet is named as such (the built screens are linked above).
        area.pending ? (
          <Placeholder
            screenIds={area.pending.screenIds}
            title={area.title}
            purpose={area.pending.purpose}
          />
        ) : null
      ) : (
        <Placeholder screenIds={area.screenIds} title={area.title} purpose={area.purpose} />
      )}
    </section>
  );
}
