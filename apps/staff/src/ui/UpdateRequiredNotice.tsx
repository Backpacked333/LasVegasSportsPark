/**
 * "Update required" for the dashboard (§4.13, SPK-AT-027): the API's answer is proposed in
 * DEC-092 and the compatibility window is DEC-061 (pending). A web build updates by reloading.
 */
import type { UpdateRequiredError } from '@sportspark/api-client';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';

export function UpdateRequiredNotice({ error }: { error: UpdateRequiredError }) {
  return (
    <main className="state" data-testid="update-required">
      <StatusBadge tone="danger" label="Update required" />
      <h2>This version of the dashboard is no longer supported</h2>
      <p>
        {error.minimumVersion ? `Version ${error.minimumVersion} or later is required. ` : ''}Reload
        the page to get the current version.
      </p>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </main>
  );
}
