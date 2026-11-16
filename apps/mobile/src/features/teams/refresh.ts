/**
 * Pull to refresh for the team screens (SCR-C-21 to SCR-C-29; ADR-008 "list mode and pull to
 * refresh"): every read on the screen again, as Home and the connectivity banner's "Refresh" do.
 * Signed out there is nothing to read, so no refresh control is offered.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSignedIn } from './queries';

export function usePullToRefresh(): { onRefresh: (() => void) | undefined; refreshing: boolean } {
  const signedIn = useSignedIn();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    void queryClient.refetchQueries({ type: 'active' }).finally(() => setRefreshing(false));
  };
  return { onRefresh: signedIn ? onRefresh : undefined, refreshing };
}
