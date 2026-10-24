// Unknown dashboard paths: shown as not available, never followed elsewhere.
import { StateView } from '../../ui/StateView';

export function NotFoundScreen() {
  return (
    <StateView
      variant="unavailable"
      title="Page not available"
      description="This address does not open anything in the dashboard."
    />
  );
}
