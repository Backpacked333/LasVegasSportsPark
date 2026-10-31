/**
 * Whose records a screen shows (SCR-C-32, SCR-C-34, SCR-C-35): waits for `GET /v1/me`, lets the
 * customer choose between themselves and the people the API says they may act for, and renders
 * the screen body for the chosen person. The choice is screen state, never a route parameter
 * (§4.14). States: loading; empty (no linked person and nobody shared); error with code; offline
 * with nothing cached; unavailable.
 */
import { presentationForError } from '@sportspark/api-client';
import { useState, type ReactNode } from 'react';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { useAccountPeople, type AccountPerson } from './people';
import { Caption, PersonPicker, Section } from './ui';

export function PeopleGate({
  pickerLabel,
  children,
}: {
  /** "Show enrollments for". */
  pickerLabel: string;
  children: (person: AccountPerson) => ReactNode;
}) {
  const { me, people, namesLoading, namesError, refetchNames } = useAccountPeople();
  const { reachable } = useConnectivity();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);

  if (me.data === undefined) {
    if (me.error) {
      const presentation = presentationForError(me.error);
      if (presentation === 'unavailable') return <StateView variant="unavailable" />;
      if (presentation !== 'offline') {
        return <StateView variant="error" error={me.error} onRetry={() => void me.refetch()} />;
      }
    }
    if (me.error || me.fetchStatus === 'paused' || reachable === false) {
      return (
        <StateView
          variant="offline-stale"
          offline
          updatedAt={null}
          now={now}
          onRetry={() => void me.refetch()}
        />
      );
    }
    return <StateView variant="loading" label="your account" />;
  }
  if (people.length === 0) {
    if (namesLoading) return <StateView variant="loading" label="your family members" />;
    return (
      <StateView
        variant="empty"
        title="Nobody to show yet"
        description="Your account is not linked to a participant yet, and nobody has shared a family member with you. Finish setting up your account from Account."
      />
    );
  }
  const person = people.find((p) => p.personId === selected) ?? people[0];
  if (!person) return null;
  return (
    <>
      <PersonPicker
        people={people}
        selected={person.personId}
        onSelect={setSelected}
        label={pickerLabel}
      />
      {namesLoading ? (
        <Section title="Family members">
          <Caption>Loading the other people on your account…</Caption>
        </Section>
      ) : null}
      {namesError ? (
        <Section title="Family members">
          <QueryErrorView error={namesError} onRetry={refetchNames} />
        </Section>
      ) : null}
      {children(person)}
    </>
  );
}
