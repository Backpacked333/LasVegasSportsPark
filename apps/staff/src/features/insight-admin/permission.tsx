/**
 * Offer a command only when the viewer's staff roles allow it (SCR-S-43 to SCR-S-48;
 * SPK-UX-005 "visibility depends on permissions"; K-05). Records such as import batches carry no
 * `availableActions` (per-record actions are not planned beyond workforce assignments and the team
 * workspace); `GET /v1/me/permissions` is the role view that replaces them. The gate renders:
 *
 * - the command when the API lists the action outright for the viewer;
 * - "not available to you" when it does not (the command is not offered);
 * - a checking state while the permissions read has not answered, and its error with "Try again"
 *   when it failed (never a guess).
 *
 * It is a view of roles, not of the record: the API still decides every command, and its
 * ACCESS_DENIED or protected NOT_FOUND is shown by the command itself.
 */
import type { ReactNode } from 'react';
import { usePermissions } from '../../api/permissions';
import { CommandError } from './feedback';

export function ActionGate({
  actionId,
  what,
  children,
}: {
  /** The API action the command is checked against, e.g. `migration.validate_batch`. */
  actionId: string;
  /** The command as a noun phrase, e.g. "Validating this batch". */
  what: string;
  children: ReactNode;
}) {
  const permissions = usePermissions();
  const allowed = permissions.isPermitted(actionId);
  if (allowed === true) return <>{children}</>;
  if (allowed === false) {
    return (
      <p className="caption" data-testid="action-not-available">
        {what} is not available to you.
      </p>
    );
  }
  if (permissions.query.error) {
    return (
      <CommandError
        error={permissions.query.error}
        onRetry={() => void permissions.query.refetch()}
      />
    );
  }
  return (
    <p className="caption" aria-busy="true">
      Checking whether {what.charAt(0).toLowerCase() + what.slice(1)} is available to you…
    </p>
  );
}
