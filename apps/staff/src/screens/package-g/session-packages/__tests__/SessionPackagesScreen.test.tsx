/**
 * SCR-S-54 Session packages placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { SESSION_PACKAGES } from '../meta';

describePackageGPlaceholder(SESSION_PACKAGES, {
  from: '/finance',
  nav: 'Finance',
  link: 'Session packages (SCR-S-54)',
});
