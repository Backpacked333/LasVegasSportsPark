/**
 * SCR-S-56 Access hardware (Package G, conditional; §3.16 Access hardware row, SPK-COND-004), in
 * the Administration area (linked from the Administration page). Route: `/admin/access-hardware/*`.
 *
 * Behind `CapabilityGate` for the `access_hardware` switch (DEC-016, DEC-080; off until a system
 * administrator turns it on). With the switch off the API keeps devices, policies and command
 * deliveries readable and never gates retiring a device or a policy (revocations must still reach
 * devices), so the gate shows its notice above the pages and only registering or changing a
 * device and drafting or approving a policy are not offered.
 *
 * Pages (nested routes, record ids only, §4.14):
 * - index: devices of a facility with health and outage age, registering one, and the facilities
 *   operator's open hardware exceptions (DevicesPage);
 * - `facilities/:facilityId/devices/:deviceId`: one device with its policies (drafted by one
 *   person, approved by another) and its command queue with delivery outcomes (DevicePage).
 *
 * Hardware access is only ever a facility arrival: never attendance, a check-in or pickup
 * authority (SPK-COND-004). The vendor is not selected (DEC-023): commands go to the API's fake
 * adapter.
 */
import { Link, Route, Routes } from 'react-router';
import { CapabilityGate } from '../../../ui/CapabilityGate';
import { StateView } from '../../../ui/StateView';
import { DevicePage } from './DevicePage';
import { DevicesPage } from './DevicesPage';
import { ACCESS_HARDWARE } from './meta';

export function AccessHardwareScreen() {
  const headingId = `package-g-${ACCESS_HARDWARE.slug}`;
  return (
    <section aria-labelledby={headingId} data-testid={headingId}>
      <h2 id={headingId}>{ACCESS_HARDWARE.title}</h2>
      <p>
        <Link to="/admin">Administration</Link>
      </p>
      <CapabilityGate
        capability={ACCESS_HARDWARE.capability}
        subject={ACCESS_HARDWARE.title}
        whenOff="notice"
        stillAvailable="Existing devices, policies and command deliveries stay readable. Retiring a device or a policy stays available, and credential revocations still reach devices."
      >
        <p className="caption">
          A hardware access is recorded as a facility arrival only: never attendance, a check-in or
          pickup authority (SPK-COND-004).
        </p>
        <Routes>
          <Route index element={<DevicesPage />} />
          <Route path="facilities/:facilityId/devices/:deviceId" element={<DevicePage />} />
          <Route path="*" element={<StateView variant="unavailable" />} />
        </Routes>
        <StateView
          variant="pending-decision"
          subject={ACCESS_HARDWARE.pending.subject}
          decisions={[...ACCESS_HARDWARE.pending.decisions]}
          owner={ACCESS_HARDWARE.pending.owner}
        />
      </CapabilityGate>
    </section>
  );
}
