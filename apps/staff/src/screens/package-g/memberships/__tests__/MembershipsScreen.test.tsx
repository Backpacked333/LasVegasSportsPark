/**
 * SCR-S-53 Memberships placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { MEMBERSHIPS } from '../meta';

describePackageGPlaceholder(MEMBERSHIPS, {
  from: '/finance',
  nav: 'Finance',
  link: 'Memberships (SCR-S-53)',
});
