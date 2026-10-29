/**
 * My session packages placeholder (Package G; SPK-COND-002, DEC-016, DEC-074).
 * Replace with the screen's own tests when the screen is built.
 */
import { describeCustomerPackageGPlaceholder } from '../../../features/package-g/testing';
import { MySessionPackagesScreen } from '../MySessionPackagesScreen';

describeCustomerPackageGPlaceholder({
  Screen: MySessionPackagesScreen,
  testID: 'screen-my-session-packages',
  title: 'Session packages',
  reference: 'Package G session packages, SPK-COND-002',
  capability: 'session_packages',
  decisions: 'DEC-016, DEC-074',
  stillAvailable: 'Packages you already hold stay available here.',
  pending: 'POL-039, POL-007',
});
