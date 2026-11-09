/**
 * Where the identity provider returns the person (§4.13, §4.14; DEC-018; SPK-IAM-002). The code in
 * the address is exchanged once for a bearer token, the login account is found (or, where the build
 * names an organization, registered: `POST /v1/accounts/register`, which gives no access), and the
 * person continues to the page they first asked for.
 *
 * The code and state are removed from the address bar before anything else, so they are not left
 * in the browser history of a shared desk device.
 *
 * States (SPK-UX-008): processing; recovery required (the answer did not belong to a sign-in
 * started here, was refused, or the provider was unreachable: start again); permission restriction
 * (the identity is verified but has no account here: an administrator creates one).
 */
import { ApiError, OidcError } from '@sportspark/api-client';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import './sign-in.css';

type Outcome =
  | { kind: 'working' }
  | { kind: 'failed'; title: string; description: string }
  | { kind: 'error'; error: ApiError };

const START_AGAIN = 'Start again from the sign-in page. Nothing was changed.';

function describe(error: unknown): Outcome {
  if (error instanceof ApiError) {
    return error.code === 'AUTHENTICATION_REQUIRED'
      ? {
          kind: 'failed',
          title: 'No staff account for this sign-in',
          description:
            'You signed in, but no active account here matches. Ask an administrator to set up your access.',
        }
      : { kind: 'error', error };
  }
  if (error instanceof OidcError) {
    if (error.code === 'provider_unavailable') {
      return {
        kind: 'failed',
        title: 'Sign-in service not available',
        description: `The sign-in service could not be reached. ${START_AGAIN}`,
      };
    }
    if (error.code === 'sign_in_refused') {
      return {
        kind: 'failed',
        title: 'Sign-in was not completed',
        description: `It was cancelled or refused. ${START_AGAIN}`,
      };
    }
  }
  return {
    kind: 'failed',
    title: 'This sign-in could not be completed',
    description: `The answer did not belong to a sign-in started in this tab. ${START_AGAIN}`,
  };
}

export function SignInCallbackScreen() {
  const { services, api, signIn } = useApp();
  const navigate = useNavigate();
  const started = useRef(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'working' });
  const managedSignIn = services.managedSignIn ?? null;
  const organizationSlug = services.config.organizationSlug ?? null;

  useEffect(() => {
    // One answer, one exchange: an effect that runs twice must not spend the code twice.
    if (started.current) return;
    started.current = true;
    const callbackUrl = window.location.href;
    window.history.replaceState(window.history.state, '', window.location.pathname);
    if (!managedSignIn) {
      setOutcome(describe(null));
      return;
    }
    void (async () => {
      try {
        const { tokens, returnTo } = await managedSignIn.complete(callbackUrl);
        const session = {
          token: tokens.bearerToken,
          expiresAt: tokens.expiresAt,
          accountId: null as string | null,
          refreshToken: tokens.refreshToken,
        };
        // Stored first so the two requests below carry the token; cleared again if they fail.
        await services.sessionStore.save(session);
        try {
          if (organizationSlug) {
            const intent = api.intentTracker().current({ body: { organizationSlug } });
            const account = await api.post('/accounts/register', {
              body: { organizationSlug },
              intent,
            });
            session.accountId = account.id;
          } else {
            session.accountId = (await api.get('/me')).principal.accountId;
          }
        } catch (error) {
          await services.sessionStore.clear();
          throw error;
        }
        await signIn(session);
        navigate(returnTo, { replace: true });
      } catch (error) {
        setOutcome(describe(error));
      }
    })();
  }, [api, managedSignIn, navigate, organizationSlug, services.sessionStore, signIn]);

  return (
    <main id="main" className="shell-main signin-main">
      <div className="signin-card">
        <h1>Signing you in</h1>
        {outcome.kind === 'working' ? (
          <StateView variant="loading" label="your sign-in" />
        ) : (
          <>
            {outcome.kind === 'error' ? (
              <StateView variant="error" error={outcome.error} />
            ) : (
              <StateView
                variant="unavailable"
                title={outcome.title}
                description={outcome.description}
              />
            )}
            <Button variant="secondary" onClick={() => navigate('/sign-in', { replace: true })}>
              Back to sign-in
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
