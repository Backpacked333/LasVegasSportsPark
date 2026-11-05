/**
 * SCR-C-39 Verified link landing, unknown destination (§4.13 "Safe deep-link destinations"). A
 * link that matches no screen resolves here and is never followed elsewhere. Which links are
 * verified and safe is DEC-061 (pending); only in-app routes exist today.
 */
import { useRouter } from 'expo-router';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';

export function NotFoundScreen() {
  const router = useRouter();
  return (
    <Screen>
      <StateView
        variant="unavailable"
        title="Link not available"
        description="This link does not open anything in the app. It may be out of date."
        actionLabel="Go to Home"
        onAction={() => router.replace('/')}
      />
    </Screen>
  );
}
