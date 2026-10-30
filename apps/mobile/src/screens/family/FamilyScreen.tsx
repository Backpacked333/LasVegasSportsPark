/**
 * SCR-C-31 Family and permissions (SPK-IAM-001, SPK-IAM-003, SPK-IAM-004, SPK-IAM-005,
 * SPK-IAM-006, SPK-ENTRY-007, DEC-004, POL-023; pickup DEC-005, DEC-075).
 *
 * - People you manage: for each person this account may act for (`GET /v1/me` authorities, plus
 *   anyone over whom it holds a paused or later grant), the six permissions one by one as the API
 *   states them, with each grant's dates, source and "Under review" from a disputed-access review
 *   (`GET /v1/me/access-grants?direction=held`). Names through `GET /v1/person-names` (names only).
 *   From each person: invite a second guardian or a delegate with explicit permissions
 *   (InviteAdultForm), and give up a permission one holds (GiveUpPermission, offered when
 *   `GET /v1/me/permissions` lists `identity.revoke_access`; the API re-checks).
 * - Households (`GET /v1/me/households`): grouping only, never authority (§4.5); create one and
 *   add people held with `view` to one, when `GET /v1/me/permissions` lists the actions.
 * - Invitations sent (`GET /v1/me/invitations?direction=sent`) with their state; withdraw an open
 *   one.
 * - Who can act for you (`GET /v1/me/access-grants?direction=over_me`).
 * - Claim a record the front desk entered (SPK-IAM-002).
 *
 * Pending decisions, shown as such: adding a child from the app (DEC-004); supervised pickup
 * (DEC-075, DEC-005); the other adults' permissions over the people one manages are not readable
 * (DEC-004) and ending another adult's access is DEC-089.
 *
 * States: loading; empty (no family members); ready; validation failure (form fields, API
 * VALIDATION_FAILED); permission restriction (a permission the parent does not hold cannot be
 * passed on; PARTICIPANT_AUTHORITY_REQUIRED shown with its reason; a grant paused by a review shows
 * "Under review"); stale version (STALE_REVISION on withdrawing an invitation or giving up a
 * permission reloads the list as it is now; data refetches on return to the app); offline (changes
 * disabled, cached data with age); processing; success (grants listed as they now stand,
 * invitation "Open until <date>"); partial completion: each section loads and fails on its own,
 * with its code and "Try again"; recovery required: not applicable, a failed command shows "Try
 * again" under the same key.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { usePersonNames, type PersonNameEntry } from '../../api/person-names';
import { useApiPages } from '../../api/useApiPages';
import { readLinkSecret } from '../../links/link-secrets';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import {
  personDisplayName,
  useMe,
  type Authority,
  type MeData,
} from '../account/components/account-data';
import { ClaimForm } from '../account/components/ClaimForm';
import { Paragraph, SectionHeader } from '../account/components/forms';
import { PersonAccessCard } from '../account/components/PersonAccess';
import { AccessOverMeSection } from './AccessOverMeSection';
import { GiveUpPermission } from './GiveUpPermission';
import {
  grantKey,
  HELD_GRANTS_REQUEST,
  isCurrentGrant,
  managedPeople,
  type GrantView,
} from './grants';
import { HouseholdsSection, type HouseholdCandidate } from './HouseholdsSection';
import { InviteAdultForm } from './InviteAdultForm';
import { SentInvitationsSection } from './SentInvitationsSection';

export function FamilyScreen() {
  return (
    <Screen>
      <SectionHeader
        title="Family and permissions"
        detail="Each permission is separate: allowing one never allows another."
      />
      <RequireSession what="your family">
        <FamilyContent />
      </RequireSession>
    </Screen>
  );
}

function FamilyContent() {
  const router = useRouter();
  const me = useMe();
  return (
    <QueryBoundary
      query={me}
      label="your family"
      empty={{ title: 'No account details', description: '' }}
      unavailableOffline={[
        'inviting someone',
        'withdrawing an invitation',
        'giving up a permission',
        'claiming a record',
      ]}
    >
      {(data) =>
        data.person ? (
          <FamilyBody me={data} />
        ) : (
          <StateView
            variant="unavailable"
            title="Finish setting up first"
            description="Family access is shown once your account is linked to your participant record."
            actionLabel="Go to account setup"
            onAction={() => router.push('/onboarding')}
          />
        )
      }
    </QueryBoundary>
  );
}

/**
 * People this account may add to a household it belongs to: those it holds `view` over now
 * (`GET /v1/me` authorities), named by the API (identity.add_household_member; the API re-checks).
 */
export function householdCandidates(
  me: MeData,
  names: ReadonlyMap<string, PersonNameEntry>,
): HouseholdCandidate[] {
  const out: HouseholdCandidate[] = [];
  for (const authority of me.authorities) {
    if (!authority.permissions.includes('view')) continue;
    const entry = names.get(authority.subjectPersonId);
    if (entry?.state !== 'ready') continue;
    out.push({ personId: authority.subjectPersonId, name: personDisplayName(entry.name) });
  }
  return out;
}

function nameOf(entry: PersonNameEntry | undefined): string {
  switch (entry?.state) {
    case 'ready':
      return personDisplayName(entry.name);
    case 'unavailable':
      return 'Name not available to you';
    case 'error':
      return `Name could not be loaded (${entry.error.code})`;
    default:
      return 'Loading name…';
  }
}

function FamilyBody({ me }: { me: MeData }) {
  const [claimToken] = useState(() => readLinkSecret('claim'));
  const held = useApiPages({
    path: '/me/access-grants',
    request: HELD_GRANTS_REQUEST,
    keyOf: grantKey,
  });
  const permissions = usePermissions();
  // Offered only when the API lists the action for this account; it re-checks every request.
  // Unknown (undefined, still loading) and not listed (null) both offer nothing.
  const mayGiveUp = Boolean(permissions.actionPermission('identity.revoke_access'));
  const people = managedPeople(me, held.data);
  const names = usePersonNames(people.map((p) => p.subjectPersonId));
  return (
    <View>
      <SectionHeader title="People you manage" />
      {people.length === 0 ? (
        <StateView
          variant="empty"
          title="No family members yet"
          description="Children and other people you manage appear here once a guardian relationship is recorded for your account. If the front desk gave you a claim code, enter it below."
        />
      ) : (
        <View accessibilityRole="list">
          {people.map((authority, index) => {
            const entry = names.get(authority.subjectPersonId);
            return (
              <ManagedPerson
                key={authority.subjectPersonId}
                authority={authority}
                index={index}
                name={nameOf(entry)}
                subject={entry?.state === 'ready' ? nameOf(entry) : 'this person'}
                grants={held.data?.filter((g) => g.subjectPersonId === authority.subjectPersonId)}
                mayGiveUp={mayGiveUp}
              />
            );
          })}
        </View>
      )}
      {held.error && held.data === undefined ? (
        <View testID="grants-error">
          <Paragraph muted>
            The dates and review state of your permissions could not be loaded. What you may do now
            is shown above.
          </Paragraph>
          <QueryErrorView error={held.error} onRetry={() => void held.refetch()} />
        </View>
      ) : null}
      <LoadMore pages={held} label="permissions" />
      <HouseholdsSection candidates={householdCandidates(me, names)} />
      <SentInvitationsSection />
      <AccessOverMeSection />
      <SectionHeader title="Claim a record from the front desk" />
      <ClaimForm
        initialToken={claimToken}
        intro="If the front desk registered your child, enter the claim code they gave you. You become guardian with exactly the permissions on the claim, and no second record is made."
      />
      <SectionHeader title="Adding a child" />
      <StateView
        variant="pending-decision"
        subject="Adding a child from the app"
        decisions={['DEC-004']}
        owner="Operator/privacy owner"
      />
      <SectionHeader title="Pickup" />
      <StateView
        variant="pending-decision"
        subject="Supervised pickup arrangements"
        decisions={['DEC-075', 'DEC-005']}
        owner="Product owner; Operations"
      />
      <SectionHeader title="Other adults" />
      <StateView
        variant="pending-decision"
        subject="Seeing the permissions other adults hold over the people you manage"
        decisions={['DEC-004']}
        owner="Operator/privacy owner"
      />
    </View>
  );
}

function ManagedPerson({
  authority,
  index,
  name,
  subject,
  grants,
  mayGiveUp,
}: {
  authority: Authority;
  index: number;
  /** The heading: the name, or why it is not shown. */
  name: string;
  /** The name in sentences ("Invite another adult for Sam Morgan"), or "this person". */
  subject: string;
  grants: GrantView[] | undefined;
  mayGiveUp: boolean;
}) {
  const [open, setOpen] = useState<'invite' | 'give-up' | null>(null);
  // Every grant not withdrawn or ended can be given up (the API refuses only a revoked one).
  const givable = (grants ?? []).filter(isCurrentGrant);
  return (
    <View>
      <PersonAccessCard authority={authority} index={index} name={name} grants={grants}>
        {open === null ? (
          <View style={styles.action}>
            {authority.permissions.length > 0 ? (
              <Button
                label={`Invite another adult for ${subject}`}
                variant="secondary"
                onPress={() => setOpen('invite')}
              />
            ) : null}
            {mayGiveUp && givable.length > 0 ? (
              <Button
                label={`Give up a permission for ${subject}`}
                variant="secondary"
                onPress={() => setOpen('give-up')}
              />
            ) : null}
          </View>
        ) : null}
        {open === 'give-up' ? (
          <GiveUpPermission personName={subject} grants={givable} onClose={() => setOpen(null)} />
        ) : null}
      </PersonAccessCard>
      {open === 'invite' ? (
        <InviteAdultForm
          subjectPersonId={authority.subjectPersonId}
          subjectName={subject}
          heldPermissions={authority.permissions}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  action: { paddingTop: spacing.sm, gap: spacing.sm },
});
