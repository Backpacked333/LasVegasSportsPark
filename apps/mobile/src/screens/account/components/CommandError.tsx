/**
 * How a failed command is shown on the account screens (SPK-UX-008, §4.10): a protected
 * NOT_FOUND is "not available" in words chosen by the screen, never "exists but denied"; a
 * permission restriction says the person cannot do this (with the API's safe reason unless the
 * screen gives its own words); a stale record offers Reload; everything else shows the API's code,
 * safe message, reference and permitted next action. "Try again" resubmits the same intent, so the
 * idempotency key is reused (§4.9).
 */
import type { ApiError } from '@sportspark/api-client';
import { StateView } from '../../../ui/StateView';

export interface NotAvailableCopy {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function CommandError({
  error,
  onRetry,
  onReload,
  notFound,
  denied,
}: {
  error: ApiError;
  onRetry?: () => void;
  /** For STALE_REVISION or INVALID_TRANSITION: reload the current state. */
  onReload?: () => void;
  /** Words for a protected NOT_FOUND on this screen. */
  notFound?: NotAvailableCopy;
  /** Words for ACCESS_DENIED or PARTICIPANT_AUTHORITY_REQUIRED; default: the API's safe message. */
  denied?: NotAvailableCopy;
}) {
  if (error.isNotFound) {
    return <StateView variant="unavailable" {...(notFound ?? {})} />;
  }
  if (error.isPermissionRestriction) {
    // SPK-UX-008: a denied permission is shown as not available, with the API's safe reason
    // unless the screen gives its own words. Never "Something went wrong".
    return (
      <StateView
        variant="unavailable"
        title={denied?.title ?? 'Not available to you'}
        description={denied?.description ?? error.message}
        actionLabel={denied?.actionLabel}
        onAction={denied?.onAction}
      />
    );
  }
  return (
    <StateView
      variant="error"
      error={error}
      onRetry={onRetry}
      onAction={error.isStale ? onReload : undefined}
    />
  );
}
