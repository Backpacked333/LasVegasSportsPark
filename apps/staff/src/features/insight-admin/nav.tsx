/**
 * Sub-navigation of the Reports area (SCR-S-43 to SCR-S-45) and of the Administration screens built
 * here (SCR-S-46 to SCR-S-48), SPK-UX-005. Every screen is listed: what a viewer may use is decided
 * by the API, and each screen renders ACCESS_DENIED as "not available". Links carry no personal data.
 */
import { NavLink } from 'react-router';

export function ReportsNav() {
  return (
    <nav aria-label="Reports screens" className="ia-subnav">
      <ul>
        <li>
          <NavLink to="/reports" end>
            Operating reports
          </NavLink>
        </li>
        <li>
          <NavLink to="/reports/insight">Utilization, economics, demand and retention</NavLink>
        </li>
        <li>
          <NavLink to="/reports/exports">Stored runs and exports</NavLink>
        </li>
      </ul>
    </nav>
  );
}

export function MigrationNav() {
  return (
    <nav aria-label="Migration screens" className="ia-subnav">
      <ul>
        <li>
          <NavLink to="/admin/migration" end>
            Import batches
          </NavLink>
        </li>
        <li>
          <NavLink to="/admin/migration/review">Review queue</NavLink>
        </li>
        <li>
          <NavLink to="/admin/migration/authority">Authority matrix</NavLink>
        </li>
        <li>
          <NavLink to="/admin/migration/mappings">External mappings</NavLink>
        </li>
      </ul>
    </nav>
  );
}
