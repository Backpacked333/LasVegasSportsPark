// Route file only: the design system gallery of development builds (src/dev-gallery, ADR-008).
// In a release build the gallery module is not bundled and this route is the "Link not available"
// landing, like any path that opens nothing.
import { Stack } from 'expo-router';
import { DesignSystemGallery } from '../src/dev-gallery';
import { NotFoundScreen } from '../src/screens/not-found/NotFoundScreen';

export default function DevGalleryRoute() {
  if (DesignSystemGallery) return <DesignSystemGallery />;
  return (
    <>
      <Stack.Screen options={{ title: 'Not available' }} />
      <NotFoundScreen />
    </>
  );
}
