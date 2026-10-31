/**
 * SCR-C-01 Onboarding and account verification (SPK-UX-001, SPK-IAM-001, SPK-IAM-002, §4.13,
 * §6.2 "Fresh installation", "Account verification", "Interrupted onboarding", DEC-018, DEC-061).
 *
 * Steps, each read from the API so an interrupted onboarding resumes where it stopped (the
 * "recovery required" state of the inventory) without anything kept on the device:
 *
 * 1. Sign in. Managed sign-in is DEC-018 (pending); development builds use the development
 *    sign-in behind the same entry.
 * 2. Participant record: `GET /v1/me` `person`. Not linked yet: claim the record the front desk
 *    created (`POST /v1/claims/{token}/accept`). Creating one's own adult record is not offered by
 *    the API (customers may create only child records), so the desk does it.
 * 3. Email or phone: added, made primary or removed here (ContactPointStep); verified by the
 *    identity provider (DEC-018, pending).
 * 4. Notification and camera permission explanations: their wording is DEC-061 (pending); the
 *    person can continue without either, and essential notices always appear in the in-app inbox
 *    (SPK-COMMS-007). Nothing is asked of the operating system in this build.
 *
 * States: loading; empty (no account yet: sign in); ready; validation failure (contact format,
 * claim code format, API VALIDATION_FAILED next to the field); permission restriction (the API's
 * reason); stale version (claim code already used, expired or withdrawn); offline (input kept,
 * commands disabled); processing (busy buttons); success (Linked, Verified); partial completion:
 * not permitted (each step is one server fact); recovery required (resumes from server state).
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { readLinkSecret } from '../../links/link-secrets';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { useMe } from '../account/components/account-data';
import { ClaimForm } from '../account/components/ClaimForm';
import { Paragraph, SectionHeader } from '../account/components/forms';
import { StepList } from '../account/components/StepList';
import { contactState, ContactPointStep, type ContactState } from './ContactPointStep';

const NOT_STARTED: StatusBadgeProps = { tone: 'neutral', label: 'Not started' };
const PERMISSIONS_PENDING: StatusBadgeProps = { tone: 'pending', label: 'Waiting on a decision' };

/** Route entry: a claim code from a link is read from memory, never from the route. */
export function OnboardingRoute() {
  const [claimToken] = useState(() => readLinkSecret('claim'));
  return <OnboardingScreen claimToken={claimToken} />;
}

export function OnboardingScreen({ claimToken = null }: { claimToken?: string | null }) {
  const { session } = useApp();
  return (
    <Screen>
      <SectionHeader
        title="Set up your account"
        detail="Each step is saved as you finish it. If you stop, you continue here next time."
      />
      {session.status === 'loading' ? (
        <StateView variant="loading" label="your account" />
      ) : session.status === 'signed_out' ? (
        <SignInStep expired={session.expired} />
      ) : (
        <SignedInOnboarding claimToken={claimToken} />
      )}
    </Screen>
  );
}

function SignInStep({ expired }: { expired: boolean }) {
  const router = useRouter();
  return (
    <View>
      <StepList
        label="Account setup steps"
        steps={[
          { title: 'Sign in', status: NOT_STARTED },
          { title: 'Participant record', status: NOT_STARTED },
          { title: 'Email or phone', status: NOT_STARTED },
          { title: 'Notifications and camera', status: PERMISSIONS_PENDING },
        ]}
      />
      <Paragraph>
        {expired ? 'Your session ended. Sign in again to continue.' : 'Sign in to start.'}
      </Paragraph>
      <View style={styles.actions}>
        <Button label="Sign in" onPress={() => router.push('/sign-in')} />
        <Button
          label="Recover an existing account"
          variant="secondary"
          onPress={() => router.push('/recovery')}
        />
      </View>
    </View>
  );
}

function SignedInOnboarding({ claimToken }: { claimToken: string | null }) {
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="your account"
      empty={{ title: 'No account details', description: '' }}
      unavailableOffline={['claiming a record', 'adding an email or phone']}
    >
      {(data) =>
        data.person ? (
          <LinkedOnboarding personId={data.person.id} />
        ) : (
          <UnlinkedOnboarding claimToken={claimToken} />
        )
      }
    </QueryBoundary>
  );
}

function UnlinkedOnboarding({ claimToken }: { claimToken: string | null }) {
  return (
    <View>
      <StepList
        label="Account setup steps"
        steps={[
          { title: 'Sign in', status: { tone: 'success', label: 'Done' } },
          { title: 'Participant record', status: { tone: 'warning', label: 'Not linked yet' } },
          { title: 'Email or phone', status: NOT_STARTED },
          { title: 'Notifications and camera', status: PERMISSIONS_PENDING },
        ]}
      />
      <SectionHeader title="Link your participant record" />
      <ClaimForm
        initialToken={claimToken}
        intro="Enter the claim code the front desk gave you. Your account is linked to the record they created, so no second participant is made."
      />
      <Paragraph muted>
        No claim code? The front desk can create your participant record and link it to this
        account. Creating it yourself in the app is not available yet.
      </Paragraph>
    </View>
  );
}

function contactStatus(state: ContactState | null): StatusBadgeProps {
  if (state === 'verified') return { tone: 'success', label: 'Verified' };
  if (state === 'pending') return { tone: 'pending', label: 'Verification pending' };
  if (state === 'none') return { tone: 'warning', label: 'Not added' };
  return { tone: 'neutral', label: 'Checking' };
}

function LinkedOnboarding({ personId }: { personId: string }) {
  const router = useRouter();
  // Same query (and cache entry) as ContactPointStep: the step list and the step agree.
  const detail = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  const state = detail.data ? contactState(detail.data.contactPoints) : null;
  // A claim link opened by a linked account claims a child's record (guardian claim). Read once:
  // a code just used to link this account is already forgotten, so it is not offered again.
  const [guardianClaim] = useState(() => readLinkSecret('claim'));
  return (
    <View>
      <StepList
        label="Account setup steps"
        steps={[
          { title: 'Sign in', status: { tone: 'success', label: 'Done' } },
          { title: 'Participant record', status: { tone: 'success', label: 'Linked' } },
          { title: 'Email or phone', status: contactStatus(state) },
          { title: 'Notifications and camera', status: PERMISSIONS_PENDING },
        ]}
      />
      {guardianClaim ? (
        <View>
          <SectionHeader title="Claim a record from the front desk" />
          <ClaimForm
            initialToken={guardianClaim}
            intro="You opened a claim link. Claiming records you as guardian with exactly the permissions on the claim; no second record is made."
          />
        </View>
      ) : null}
      <ContactPointStep personId={personId} />
      <SectionHeader title="Notifications and camera" />
      <StateView
        variant="pending-decision"
        subject="Explaining and asking for notification and camera permission"
        decisions={['DEC-061']}
        owner="Technical lead/operator"
      />
      <Paragraph>
        You can continue without them. Essential notices always appear in the app's inbox.
      </Paragraph>
      <View style={styles.done}>
        {state === 'verified' ? (
          <>
            <StatusBadge tone="success" label="Verified" />
            <Paragraph inset={false}>Your account is set up.</Paragraph>
          </>
        ) : null}
        <Button label="Go to Home" variant="secondary" onPress={() => router.replace('/')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
  done: { paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, gap: spacing.sm },
});
