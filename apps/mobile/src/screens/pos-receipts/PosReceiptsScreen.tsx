/**
 * My point-of-sale receipts (Package G, conditional; SPK-PAY-002, §3.16 POS; beside the payment
 * receipts of SCR-C-34). Route: `/pos-receipts`, from Account.
 *
 * Placeholder until the point-of-sale screen group builds it over `GET /v1/me/pos-receipts`
 * (paged: `useApiPages`; money in minor units with its currency, formatted for display only).
 * Behind `CapabilityGate` for `point_of_sale` (DEC-016, DEC-079) with `whenOff="notice"`: receipts
 * of earlier sales stay readable.
 */
import { PackageGPlaceholder } from '../../features/package-g/PackageGPlaceholder';

export function PosReceiptsScreen() {
  return (
    <PackageGPlaceholder
      testID="screen-pos-receipts"
      reference="Package G point-of-sale receipts, SPK-PAY-002"
      title="Point-of-sale receipts"
      purpose="Receipts of purchases at the facility desk, with their lines, taxes, tenders and returns."
      capability="point_of_sale"
      what="your receipts"
      whenOff="notice"
      stillAvailable="Receipts of earlier purchases stay available here."
      pending={{
        subject: 'Which taxes and fees appear on receipts',
        decisions: ['DEC-057'],
        owner: 'Finance',
      }}
    />
  );
}
