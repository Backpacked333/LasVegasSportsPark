import type { AccessDevicePort } from '../entry.ports';

/**
 * The access-device port while no hardware is selected (`ACCESS_DEVICE_PROVIDER=none`, §5.2,
 * DEC-023): every device command fails with a readable reason, so nothing waits on a receipt
 * that cannot come. Hardware access never establishes attendance or pickup (SPK-COND-004), so
 * the desk's own records are unaffected.
 */
export const unselectedAccessDeviceProvider: AccessDevicePort = {
  name: 'none',
  sendCommand: async () => ({ outcome: 'failed', error: 'no_access_hardware_selected' }),
};
