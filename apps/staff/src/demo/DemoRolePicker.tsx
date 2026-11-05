/**
 * Demo sign-in: pick a role and sign in as the seeded account for it (`POST /v1/dev/tokens`, which
 * the API answers only with its local identity provider outside production). Demo builds only.
 */
import { presentationForError } from '@sportspark/api-client';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiCommand } from '../api/useApiCommand';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { StateView } from '../ui/StateView';
import { demoAccountsFromEnv, type DemoAccounts } from './accounts';
import { DEMO_ROLES, type DemoRole } from './roles';
import { setDemoState } from './store';

export function DemoRolePicker({ accounts = demoAccountsFromEnv() }: { accounts?: DemoAccounts }) {
  const { signIn } = useApp();
  const navigate = useNavigate();
  const mint = useApiCommand('post', '/dev/tokens');
  const [pending, setPending] = useState<string | null>(null);
  const noAccounts = Object.keys(accounts).length === 0;

  const choose = async (role: DemoRole) => {
    const accountId = role.subject ? accounts[role.subject] : undefined;
    if (!accountId) return;
    setPending(role.id);
    try {
      const token = await mint.submit({ body: { accountId } });
      setDemoState({ roleId: role.id, step: 0, open: true });
      await signIn({ token: token.token, expiresAt: token.expiresAt, accountId: token.accountId });
      navigate(role.tour[0]?.path ?? '/today', { replace: true });
    } catch {
      // Shown below from mint.error.
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="demo-picker" aria-labelledby="demo-picker-title">
      <h2 id="demo-picker-title">Demo mode: choose who you are</h2>
      <p>
        Each role signs in to the real software with sample data, then a short tour walks through
        what that person does. Nothing here touches real people or real money.
      </p>
      {noAccounts ? (
        <StateView
          variant="unavailable"
          title="Demo accounts not set up"
          description="Start the demo with pnpm demo, which seeds the demo accounts and starts the API."
        />
      ) : null}
      <ul className="demo-roles">
        {DEMO_ROLES.map((role) => {
          const available = role.subject ? Boolean(accounts[role.subject]) : false;
          return (
            <li key={role.id} className="demo-role">
              <h3>{role.title}</h3>
              <p>{role.who}</p>
              {role.subject ? (
                <Button
                  onClick={() => void choose(role)}
                  disabled={!available || (pending !== null && pending !== role.id)}
                  busy={pending === role.id}
                >
                  Sign in as {role.title.toLowerCase()}
                </Button>
              ) : (
                <p className="demo-elsewhere">{role.elsewhere}</p>
              )}
            </li>
          );
        })}
      </ul>
      {mint.error ? (
        presentationForError(mint.error) === 'unavailable' ? (
          <StateView
            variant="unavailable"
            title="Demo sign-in not available"
            description="The API is not running in demo mode, or the demo database was reset. Restart with pnpm demo."
          />
        ) : (
          <StateView variant="error" error={mint.error} />
        )
      ) : null}
    </section>
  );
}
