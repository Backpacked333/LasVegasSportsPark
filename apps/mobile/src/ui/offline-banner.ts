/**
 * Whether the screen around a component draws the app's connectivity banner (`Screen` always
 * does, ADR-008). While the device is offline that banner already says "You are offline", the age
 * of what is shown and what needs a connection; a section inside the screen then says only what is
 * its own, on one quiet line, instead of a second offline card (`StateView`).
 */
import { createContext, useContext } from 'react';

export const OfflineBannerContext = createContext(false);

export function useOfflineBannerShown(): boolean {
  return useContext(OfflineBannerContext);
}
