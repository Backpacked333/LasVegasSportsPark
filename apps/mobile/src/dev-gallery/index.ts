/**
 * The design system gallery (ADR-008), development builds only. `__DEV__` is `false` in release
 * bundles, Metro folds the conditional before collecting dependencies, and no gallery module is
 * bundled: the route `app/dev-gallery.tsx` then shows "Link not available", and
 * `scripts/check-release-bundle.mjs` fails the export if the gallery's title reaches the bundle.
 */
import type { ComponentType } from 'react';
import type * as GalleryModule from './GalleryScreen';

export const DesignSystemGallery: ComponentType | null = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay a conditional require so release bundles drop the module
    (require('./GalleryScreen') as typeof GalleryModule).GalleryScreen
  : null;
