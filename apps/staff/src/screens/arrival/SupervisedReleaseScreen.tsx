/**
 * SCR-S-30 Supervised release (SPK-ENTRY-007, SPK-COND-004, §4.15, SPK-AT-016, DEC-005,
 * DEC-034, DEC-075). The front desk identifies the collecting adult (their pass, or a
 * description), chooses the child, and records the release; the API verifies current pickup
 * authority online at that moment. Whether supervised release applies to a program is DEC-075
 * (pending): the API treats every child participant of a session as released through this flow.
 */
import { ARRIVAL_TABS, AreaTabs } from '../../features/operations/AreaTabs';
import { useOperatingFacility } from '../../features/operations/context';
import { ChooseFacility } from '../../features/operations/feedback';
import { OfflineQueueStatus } from '../../features/operations/offline/OfflineQueueStatus';
import { StateView } from '../../ui/StateView';
import { ReleasePanel } from './ReleasePanel';

export function SupervisedReleaseScreen() {
  const facility = useOperatingFacility();
  return (
    <section aria-labelledby="release-title">
      <h2 id="release-title">Supervised release</h2>
      <AreaTabs label="Arrival and attendance screens" tabs={ARRIVAL_TABS} />
      <OfflineQueueStatus />
      {!facility.facilityId ? (
        facility.loading ? (
          <StateView variant="loading" label="your facilities" />
        ) : (
          <ChooseFacility purpose="release children to an authorised adult" />
        )
      ) : (
        <ReleasePanel facilityId={facility.facilityId} timezone={facility.timezone} />
      )}
    </section>
  );
}
