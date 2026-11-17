/**
 * SCR-C-01 Onboarding and account verification (SPK-UX-001, SPK-IAM-001, SPK-IAM-002, §4.13,
 * §6.2 "Fresh installation", "Account verification", "Interrupted onboarding", DEC-018, DEC-061).
 *
 * Three illustrated steps (ADR-008, PA-11 customer words), shown with `ProgressSteps` over a list
 * of the steps and their states ("Step 2 of 3, Your record, Linked"), then the current step with its
 * artwork (`onboardingArtwork`: welcome, family, pass). Each state is read from the API, so an
 * interrupted onboarding resumes where it stopped (the "recovery required" state of the inventory)
 * without anything kept on the device:
 *
 * 1. Sign in. Managed sign-in is DEC-018 (pending); development builds use the development
 *    sign-in behind the same entry.
 * 2. Your record: `GET /v1/me` `person`. Not linked yet: claim the record the front desk created
 *    (`POST /v1/claims/{token}/accept`) or create an adult record for this authenticated account
 *    (`POST /v1/me/registration`). This does not create login credentials; identity-provider
 *    selection and contact verification remain pending DEC-018.
 * 3. Email or phone: added, made primary or removed here (ContactPointStep); verified by the
 *    identity provider (DEC-018, pending).
 *    With it, the notification and camera permission explanations: their wording is DEC-061
 *    (pending); the person can carry on without either, and essential notices always appear in the
 *    in-app inbox (SPK-COMMS-007). Nothing is asked of the operating system in this build.
 *
 * States: loading; empty (no account yet: sign in); ready; validation failure (contact format,
 * claim code format, API VALIDATION_FAILED next to the field); permission restriction (the API's
 * reason); stale version (claim code already used, expired or withdrawn); offline (input kept,
 * commands disabled); processing (busy buttons); success (Linked, Verified); partial completion:
 * not permitted (each step is one server fact); recovery required (resumes from server state).
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { onboardingArtwork, type OnboardingArt } from '../../artwork/manifest';
import { pendingMessage } from '../../copy/pending';
import { useApiQuery } from '../../api/useApiQuery';
import { useLinkSecret } from '../../links/useLinkSecret';
import { useApp } from '../../providers/AppProviders';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { ProgressSteps } from '../../ui/ProgressSteps';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { continuousCorners, layout, makeStyles, radius, spacing } from '../../ui/theme';
import { useMe } from '../account/components/account-data';
import { ClaimForm } from '../account/components/ClaimForm';
import { contactState, ContactPointStep, type ContactState } from './ContactPointStep';
import { SelfRegistrationForm } from './SelfRegistrationForm';

const NOT_STARTED: StatusBadgeProps = { tone: 'neutral', label: 'Not started' };
const DONE: StatusBadgeProps = { tone: 'success', label: 'Done' };

/** The three steps, in order, with the artwork of each. */
export const ONBOARDING_STEPS: readonly { title: string; art: OnboardingArt }[] = [
  { title: 'Sign in', art: 'welcome' },
  { title: 'Your record', art: 'family' },
  { title: 'Email or phone', art: 'pass' },
];

/**
 * Route entry: a claim code from a link is read from memory, never from the route, and only for
 * the account signed in now (R3-SECURITY-07).
 */
export function OnboardingRoute() {
  const claimToken = useLinkSecret('claim');
  return <OnboardingScreen claimToken={claimToken} />;
}

export function OnboardingScreen({ claimToken = null }: { claimToken?: string | null }) {
  const { session } = useApp();
  const styles = useStyles();
  return (
    <Screen>
      {/* The title bar says "Account setup": the page does not repeat it as a heading. */}
      <View style={styles.intro}>
        <Text variant="callout" tone="muted">
          Each step is saved as you finish it. If you stop, you carry on here next time.
        </Text>
      </View>
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

/**
 * Where the person is: the progress bar ("Step 2 of 3, Your record"), then each step with its
 * state, one element each for screen readers ("Step 2 of 3, Your record, Linked").
 */
function Steps({ current, states }: { current: number; states: readonly StatusBadgeProps[] }) {
  const styles = useStyles();
  const titles = ONBOARDING_STEPS.map((step) => step.title);
  return (
    <View style={styles.steps}>
      <ProgressSteps steps={titles} current={current} testID="onboarding-progress" />
      <View accessibilityRole="list" accessibilityLabel="Account setup steps" style={styles.list}>
        {ONBOARDING_STEPS.map((step, index) => {
          const status = states[index] ?? NOT_STARTED;
          return (
            <View
              key={step.title}
              style={styles.stepRow}
              accessible
              accessibilityLabel={`Step ${index + 1} of ${titles.length}, ${step.title}, ${status.label}`}
            >
              <Text variant="headline" tone="muted" tabular style={styles.number}>
                {index + 1}
              </Text>
              <Text variant="body" style={styles.stepTitle}>
                {step.title}
              </Text>
              <StatusBadge {...status} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** The current step: its artwork (decorative), its title and what to do. */
function StepHero({ step, title, message }: { step: number; title: string; message: string }) {
  const styles = useStyles();
  const art = ONBOARDING_STEPS[step]?.art ?? 'welcome';
  return (
    <View style={styles.hero} testID={`onboarding-step-${step + 1}`}>
      <Artwork source={onboardingArtwork[art]} aspectRatio={4 / 3} />
      <Text variant="title2" heading>
        {title}
      </Text>
      <Text variant="body">{message}</Text>
    </View>
  );
}

function SignInStep({ expired }: { expired: boolean }) {
  const router = useRouter();
  const styles = useStyles();
  return (
    <View>
      <Steps current={0} states={[NOT_STARTED, NOT_STARTED, NOT_STARTED]} />
      <StepHero
        step={0}
        title="Welcome to the park"
        message={expired ? 'Your session ended. Sign in again to continue.' : 'Sign in to start.'}
      />
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
      unavailableOffline={['claiming or creating a record', 'adding an email or phone']}
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
  const styles = useStyles();
  const [method, setMethod] = useState<'claim' | 'register'>('claim');
  return (
    <View>
      <Steps
        current={1}
        states={[DONE, { tone: 'warning', label: 'Not linked yet' }, NOT_STARTED]}
      />
      <StepHero
        step={1}
        title="Link your record"
        message="Claim a record the front desk made, or create an adult record for this signed-in account."
      />
      <View style={styles.methods}>
        <Button
          label="Use a claim code"
          variant={method === 'claim' ? 'primary' : 'secondary'}
          onPress={() => setMethod('claim')}
        />
        <Button
          label="Create a new adult record"
          variant={method === 'register' ? 'primary' : 'secondary'}
          onPress={() => setMethod('register')}
        />
      </View>
      {/* A code from another account's link is never kept in the field (R3-SECURITY-07). */}
      <View style={method === 'claim' ? undefined : styles.hidden}>
        <ClaimForm
          key={claimToken ?? 'typed'}
          initialToken={claimToken}
          intro="Enter the claim code from the front desk. It links this account to the record they made, so no second record is made."
        />
      </View>
      <View style={method === 'register' ? undefined : styles.hidden}>
        <SelfRegistrationForm />
      </View>
      <Text variant="callout" tone="muted" style={styles.note}>
        Already have a record but no claim code? Ask the front desk to help.
      </Text>
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
  const styles = useStyles();
  // Same query (and cache entry) as ContactPointStep: the step list and the step agree.
  const detail = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  const state = detail.data ? contactState(detail.data.contactPoints) : null;
  // A claim link opened by a linked account claims a child's record (guardian claim). Read once
  // per account: a code just used to link this account is already forgotten, so it is not offered
  // again.
  const guardianClaim = useLinkSecret('claim');
  return (
    <View>
      <Steps
        current={2}
        states={[DONE, { tone: 'success', label: 'Linked' }, contactStatus(state)]}
      />
      <StepHero
        step={2}
        title="Stay in touch"
        message="Add an email or phone, so the facility can reach you about your activities."
      />
      {guardianClaim ? (
        <View>
          <Text variant="title3" heading style={styles.heading}>
            Claim a record from the front desk
          </Text>
          <ClaimForm
            initialToken={guardianClaim}
            intro="You opened a claim link. Claiming it makes you the guardian on that record, with exactly the permissions it lists; no second record is made."
          />
        </View>
      ) : null}
      <ContactPointStep personId={personId} />
      <Text variant="title3" heading style={styles.heading}>
        Notifications and camera
      </Text>
      <StateView
        variant="pending-decision"
        subject="Notifications and camera"
        decisions={['DEC-061']}
        owner="Technical lead/operator"
        message={pendingMessage('DEC-061')}
      />
      <View style={styles.done}>
        {state === 'verified' ? (
          <>
            <StatusBadge tone="success" label="Verified" />
            <Text variant="body">Your account is set up.</Text>
          </>
        ) : null}
        <Button label="Go to Home" variant="secondary" onPress={() => router.replace('/')} />
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  intro: { paddingHorizontal: layout.gutter, paddingTop: spacing.md, gap: spacing.xs },
  steps: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.md },
  list: { gap: spacing.sm },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  number: { width: 24, textAlign: 'center' },
  stepTitle: { flex: 1 },
  hero: {
    marginHorizontal: layout.gutter,
    marginTop: spacing.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    borderRadius: radius.lg,
    ...continuousCorners,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heading: { paddingHorizontal: layout.gutter, paddingTop: spacing.xl, paddingBottom: spacing.xs },
  note: { paddingHorizontal: layout.gutter, paddingTop: spacing.sm },
  methods: { paddingHorizontal: layout.gutter, paddingTop: spacing.md, gap: spacing.sm },
  hidden: { display: 'none' },
  actions: { paddingHorizontal: layout.gutter, paddingTop: spacing.lg, gap: spacing.sm },
  done: { paddingHorizontal: layout.gutter, paddingVertical: spacing.xl, gap: spacing.sm },
}));
