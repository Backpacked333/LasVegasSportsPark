/**
 * Sub-navigation of the People and families area (SPK-UX-005): person search (SCR-S-20), the
 * organization's invitations (SCR-S-21, SPK-IAM-004), disputed access reviews (SCR-S-22) and
 * duplicate review (SCR-S-23). Household, relationships and grants (SCR-S-21) open from a
 * person's record.
 */
import { NavLink } from 'react-router';
import '../../ui/form-fields.css';

export function PeopleNav() {
  return (
    <nav aria-label="People and families">
      <ul className="subnav">
        <li>
          <NavLink to="/people" end>
            Find a person
          </NavLink>
        </li>
        <li>
          <NavLink to="/people/invitations">Invitations</NavLink>
        </li>
        <li>
          <NavLink to="/people/access-reviews">Access reviews</NavLink>
        </li>
        <li>
          <NavLink to="/people/duplicates">Duplicate review</NavLink>
        </li>
      </ul>
    </nav>
  );
}
