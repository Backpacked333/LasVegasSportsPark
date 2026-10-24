/**
 * Shows the content only with a session; otherwise the sign-in prompt, including the
 * "session ended" case after the API rejected the stored token (§4.13 session expiry and
 * recovery, §6.2 "Expired session").
 */
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { useApp } from '../providers/AppProviders';
import { StateView } from '../ui/StateView';

export function RequireSession({ what, children }: { what: string; children: ReactNode }) {
  const { session } = useApp();
  const router = useRouter();
  if (session.status === 'loading') return <StateView variant="loading" label="your account" />;
  if (session.status === 'signed_out') {
    return (
      <StateView
        variant="empty"
        title={session.expired ? 'Your session ended' : 'Sign in'}
        description={session.expired ? `Sign in again to see ${what}.` : `Sign in to see ${what}.`}
        actionLabel="Sign in"
        onAction={() => router.push('/sign-in')}
      />
    );
  }
  return <>{children}</>;
}
