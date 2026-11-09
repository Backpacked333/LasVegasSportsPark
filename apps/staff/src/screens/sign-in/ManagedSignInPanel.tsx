/**
 * Managed staff sign-in (§4.13, §4.14; DEC-018): one button that hands the person to the identity
 * provider, where the password and any second factor are entered. This page never sees them.
 *
 * States (SPK-UX-008): ready; processing (leaving for the provider); offline (the button is
 * disabled, sign-in needs a connection); unavailable (the provider could not be reached: the
 * person can try again, nothing was changed).
 */
import { OidcError } from '@sportspark/api-client';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useApp } from '../../providers/AppProviders';
import type { ManagedSignIn } from '../../session/managed-sign-in';
import { Button } from '../../ui/Button';

export function ManagedSignInPanel({ managedSignIn }: { managedSignIn: ManagedSignIn }) {
  const { online } = useApp();
  const location = useLocation();
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const from = (location.state as { from?: string } | null)?.from;

  const start = async () => {
    setLeaving(true);
    setProblem(null);
    try {
      await managedSignIn.start(from ?? '/today');
    } catch (error) {
      setLeaving(false);
      setProblem(
        error instanceof OidcError && error.code !== 'provider_unavailable'
          ? error.message
          : 'The sign-in service could not be reached. Nothing was changed. Try again.',
      );
    }
  };

  return (
    <section className="state" aria-label="Sign in">
      <p>You sign in on the sign-in service's page, then come back here.</p>
      <Button onClick={() => void start()} busy={leaving} disabled={!online}>
        Continue to sign-in
      </Button>
      <p className="error-text" role="alert">
        {!online ? 'Signing in needs a connection.' : (problem ?? '')}
      </p>
    </section>
  );
}
