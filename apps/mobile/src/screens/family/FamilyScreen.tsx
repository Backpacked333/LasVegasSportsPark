/**
 * SCR-C-31 Family and permissions (SPK-IAM-001, SPK-IAM-003, SPK-IAM-004, SPK-IAM-005,
 * SPK-IAM-006, SPK-ENTRY-007, DEC-004, POL-023; pickup DEC-005, DEC-075).
 *
 * Shows, for each person this account may act for, the six permissions one by one as the API
 * states them now (`GET /v1/me` authorities), never inferred from household membership. From each
 * person the parent can invite a second guardian or a pickup delegate with explicit permissions
 * (InviteAdultForm), and can claim a record the front desk entered (SPK-IAM-002). Nothing here
 * reads another household: the only people shown are those the API lists for this account.
 *
 * Not available from the API (reported, shown as "not shown yet"): household members, the other
 * adults who hold permissions over a person, grants suspended by a disputed-access review ("Under
 * review"), and the ids needed to withdraw a permission. Adding a child from the app waits on
 * DEC-004 (guardian verification and child accounts); supervised pickup on DEC-075 and DEC-005.
 *
 * States: loading; empty (no family members); ready; validation failure (form fields, API
 * VALIDATION_FAILED); permission restriction (a permission the parent does not hold cannot be
 * passed on; PARTICIPANT_AUTHORITY_REQUIRED shown with its reason); stale version (STALE_REVISION
 * on withdrawing an invitation offers Reload; data refetches on return to the app); offline
 * (changes disabled, cached data with age); processing; success (grants listed as they now stand,
 * invitation "Open until <date>"); partial completion: not permitted; recovery required: not
 * applicable, a failed command shows "Try again" under the same key.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { readLinkSecret } from '../../links/link-secrets';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import { usePersonName, useMe, type Authority } from '../account/components/account-data';
import { ClaimForm } from '../account/components/ClaimForm';
import { SectionHeader } from '../account/components/forms';
import { PersonAccessCard } from '../account/components/PersonAccess';
import { InviteAdultForm } from './InviteAdultForm';

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
  const [claimToken] = useState(() => readLinkSecret('claim'));
  return (
    <QueryBoundary
      query={me}
      label="your family"
      empty={{ title: 'No account details', description: '' }}
      unavailableOffline={['inviting someone', 'withdrawing an invitation', 'claiming a record']}
    >
      {(data) =>
        data.person ? (
          <View>
            <SectionHeader title="People you manage" />
            {data.authorities.length === 0 ? (
              <StateView
                variant="empty"
                title="No family members yet"
                description="Children and other people you manage appear here once a guardian relationship is recorded for your account. If the front desk gave you a claim code, enter it below."
              />
            ) : (
              <View accessibilityRole="list">
                {data.authorities.map((authority, index) => (
                  <ManagedPerson
                    key={authority.subjectPersonId}
                    authority={authority}
                    index={index}
                  />
                ))}
              </View>
            )}
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
            <StateView
              variant="unavailable"
              title="Not shown in the app yet"
              description="Household members, other adults who hold permissions over the people you manage, permissions under review and withdrawing a permission are not shown here yet. Ask the front desk."
            />
          </View>
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

function ManagedPerson({ authority, index }: { authority: Authority; index: number }) {
  const [inviting, setInviting] = useState(false);
  const nameState = usePersonName(authority.subjectPersonId);
  const name = nameState.status === 'ready' ? nameState.name : 'this person';
  return (
    <View>
      <PersonAccessCard authority={authority} index={index}>
        {inviting ? null : (
          <View style={styles.action}>
            <Button
              label={`Invite another adult for ${name}`}
              variant="secondary"
              onPress={() => setInviting(true)}
            />
          </View>
        )}
      </PersonAccessCard>
      {inviting ? (
        <InviteAdultForm
          subjectPersonId={authority.subjectPersonId}
          subjectName={name}
          heldPermissions={authority.permissions}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  action: { paddingTop: spacing.sm },
});
