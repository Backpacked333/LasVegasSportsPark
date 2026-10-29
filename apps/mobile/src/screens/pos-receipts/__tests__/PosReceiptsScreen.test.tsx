/**
 * Point-of-sale receipts placeholder (Package G; SPK-PAY-002, DEC-016, DEC-079).
 * Replace with the screen's own tests when the screen is built.
 */
import { describeCustomerPackageGPlaceholder } from '../../../features/package-g/testing';
import { PosReceiptsScreen } from '../PosReceiptsScreen';

describeCustomerPackageGPlaceholder({
  Screen: PosReceiptsScreen,
  testID: 'screen-pos-receipts',
  title: 'Point-of-sale receipts',
  reference: 'Package G point-of-sale receipts, SPK-PAY-002',
  capability: 'point_of_sale',
  decisions: 'DEC-016, DEC-079',
  stillAvailable: 'Receipts of earlier purchases stay available here.',
  pending: 'DEC-057',
});
