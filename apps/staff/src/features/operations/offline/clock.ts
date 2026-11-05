/**
 * The service's clock as this device sees it, taken from one read (§4.15, SPK-AT-018).
 *
 * The API checks a queued batch against its own clock (apps/api entry offline-sync.service, with
 * `clockSkewToleranceMinutes`, 5 by default): it refuses a roster snapshot dated more than the
 * tolerance after it received the batch (`snapshot_in_future`), and rejects an item observed more
 * than the tolerance after it received the batch (`observed_in_future`) or before the snapshot
 * (`observed_before_snapshot`). The snapshot time and every observed time queued against it must
 * therefore be on one clock. Dating the snapshot by the service but the observations by the device
 * would reject every observation of a device whose clock runs slow by more than the tolerance, and
 * would still reject a fast device's observations.
 *
 * `serviceClockOf` takes the offset between the service's time of a read (its `Date` header, or a
 * time the API returned, such as a scan's `scannedAt`) and this device's receipt time. The snapshot
 * is dated `at(receipt)` and each observation `at(device time of the tap)`: both are the service's
 * time, whichever way the device clock is off. When the service's time is not readable (no `Date`
 * header, or a cross-origin response that does not expose it) the offset is zero and both stay on
 * the device clock, consistently.
 *
 * The offset carries the response's travel time and the header's one-second resolution, far below
 * the API's tolerance.
 */
export interface ServiceClock {
  /** Service time minus device time, in milliseconds (0 when the service's time is not known). */
  readonly offsetMs: number;
  /** The service's time for a time read on this device's clock, as an ISO string. */
  at(deviceTime: Date): string;
}

export function serviceClockOf(
  serviceTime: Date | string | null | undefined,
  deviceReceipt: Date,
): ServiceClock {
  const service =
    serviceTime === null || serviceTime === undefined
      ? Number.NaN
      : new Date(serviceTime).getTime();
  const offsetMs = Number.isNaN(service) ? 0 : service - deviceReceipt.getTime();
  return {
    offsetMs,
    at: (deviceTime) => new Date(deviceTime.getTime() + offsetMs).toISOString(),
  };
}
