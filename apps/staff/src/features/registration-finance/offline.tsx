/**
 * Offline behaviour of commands on these screens (§4.15, SPK-UX-008 offline): reads stay on screen
 * with their age (QueryBoundary), commands are disabled and say so, and typed input is kept. No
 * command is queued: the dashboard never pretends a queued action is committed.
 */
import { useApp } from '../../providers/AppProviders';

export function useOnline(): boolean {
  return useApp().online;
}

export function OfflineCaption({ action }: { action: string }) {
  const online = useOnline();
  if (online) return null;
  return (
    <p className="caption" role="status">
      You are offline: {action} needs a connection. What you entered is kept.
    </p>
  );
}
