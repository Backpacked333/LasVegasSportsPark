/**
 * Development sign-in (development builds only): a token from the API's local identity provider
 * (`POST /v1/dev/tokens`), which answers NOT_FOUND unless the API runs with AUTH_MODE=local outside
 * production (§5.2). The account id is never logged or put in the URL.
 */
import { presentationForError } from '@sportspark/api-client';
import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useApiCommand } from '../api/useApiCommand';
import { useApp } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { StateView } from '../ui/StateView';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function DevSignIn() {
  const { signIn } = useApp();
  const navigate = useNavigate();
  const inputId = useId();
  const [accountId, setAccountId] = useState('');
  const mint = useApiCommand('post', '/dev/tokens');
  const trimmed = accountId.trim();
  const valid = UUID.test(trimmed);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    try {
      const token = await mint.submit({ body: { accountId: trimmed } });
      await signIn({ token: token.token, expiresAt: token.expiresAt, accountId: token.accountId });
      navigate('/today', { replace: true });
    } catch {
      // Rendered below from mint.error; the input is kept (SPK-UX-008).
    }
  };

  return (
    <section className="state">
      <h2>Development sign-in</h2>
      <p>
        Gets a token from the API's local identity provider. Works only against an API running in
        development.
      </p>
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <label htmlFor={inputId}>Account id</label>
        <input
          id={inputId}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={accountId.length > 0 && !valid}
          aria-describedby={`${inputId}-error`}
        />
        <p id={`${inputId}-error`} className="error-text" aria-live="polite">
          {accountId.length > 0 && !valid ? 'Enter the account id as a UUID.' : ''}
        </p>
        <Button type="submit" disabled={!valid} busy={mint.isProcessing}>
          Sign in
        </Button>
      </form>
      {mint.error ? (
        presentationForError(mint.error) === 'unavailable' ? (
          <StateView
            variant="unavailable"
            title="Development sign-in not available"
            description="The API is not running with its local identity provider, or no active local account has this id."
          />
        ) : (
          <StateView variant="error" error={mint.error} />
        )
      ) : null}
    </section>
  );
}
