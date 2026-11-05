/** SCR-S-56 page paths below `/admin/access-hardware` (record ids only, never names, §4.14). */
import { ACCESS_HARDWARE } from './meta';

const BASE = ACCESS_HARDWARE.path;

export const ACCESS_PATHS = {
  base: BASE,
  device: (facilityId: string, deviceId: string) =>
    `${BASE}/facilities/${facilityId}/devices/${deviceId}`,
} as const;

export const DEVICES_QUERY_PREFIX = ['api', '/access-devices'] as const;
