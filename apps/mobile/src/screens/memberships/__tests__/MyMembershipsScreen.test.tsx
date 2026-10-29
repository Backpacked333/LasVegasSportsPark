/**
 * My memberships placeholder (Package G; SPK-COND-001, DEC-016, DEC-072).
 * Replace with the screen's own tests when the screen is built.
 */
import { describeCustomerPackageGPlaceholder } from '../../../features/package-g/testing';
import { MyMembershipsScreen } from '../MyMembershipsScreen';

describeCustomerPackageGPlaceholder({
  Screen: MyMembershipsScreen,
  testID: 'screen-my-memberships',
  title: 'Memberships',
  reference: 'Package G memberships, SPK-COND-001',
  capability: 'memberships',
  decisions: 'DEC-016, DEC-072',
  stillAvailable: 'Memberships you already hold stay available here.',
  pending: 'POL-038, DEC-007',
});
