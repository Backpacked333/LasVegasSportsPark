/**
 * SCR-C-31 "Who can act for you" (SPK-IAM-003, SPK-IAM-005, SPK-IAM-006):
 * `GET /v1/me/access-grants?direction=over_me` lists the grants other adults hold over this person,
 * each permission separately, with its state ("Allowed", "Under review", "Starts <date>",
 * "Withdrawn", "Ended"), its dates and where it came from. Only current grants are listed here.
 * Ending someone else's access from the app is not offered: ending relationships and per-person
 * restrictions are DEC-089 and DEC-004 (Operator/privacy owner), shown as pending with the plain
 * message "Ask the front desk to change this for you." (codes in "Details for support"). Each
 * adult is a person card with their avatar (PA-11, ADR-008).
 */
import { View } from 'react-native';
import { useApiPages } from '../../api/useApiPages';
import { pendingMessageFor } from '../../copy/pending';
import { Card } from '../../ui/Card';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { spacing } from '../../ui/theme';
import { formatDateTime, permissionLabel } from '../account/components/account-data';
import { PersonHeading } from '../account/components/PersonHeading';
import { grantKey, grantStatusLabel, isCurrentGrant, sourceText, type GrantView } from './grants';
import { useKnownFacilityZone } from '../../features/today/known-zone';

/** Current grants grouped by the adult who holds them, in the order the API listed them. */
export function groupByActor(
  grants: readonly GrantView[],
): { actorId: string; grants: GrantView[] }[] {
  const groups: { actorId: string; grants: GrantView[] }[] = [];
  for (const grant of grants) {
    if (!isCurrentGrant(grant)) continue;
    const group = groups.find((g) => g.actorId === grant.actorPersonId);
    if (group) group.grants.push(grant);
    else groups.push({ actorId: grant.actorPersonId, grants: [grant] });
  }
  return groups;
}

export function AccessOverMeSection() {
  const overMe = useApiPages({
    path: '/me/access-grants',
    request: { query: { direction: 'over_me', limit: 100 } },
    keyOf: grantKey,
  });
  return (
    <Section
      title="Who can act for you"
      subtitle="Other adults who hold permissions over you, each permission listed separately."
      variant="plain"
    >
      <QueryBoundary
        query={overMe}
        label="who can act for you"
        isEmpty={(items) => groupByActor(items).length === 0}
        empty={{
          title: 'Nobody else holds permissions over you',
          description: 'If another adult is given a permission over you, it is listed here.',
        }}
      >
        {(items) => (
          <View style={styles.cards}>
            {groupByActor(items).map((group) => (
              <ActorCard key={group.actorId} grants={group.grants} />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={overMe} label="permissions held over you" />
      <StateView
        variant="pending-decision"
        subject="Ending another adult's permissions over you or the people you manage"
        decisions={['DEC-089', 'DEC-004']}
        owner="Operator/privacy owner"
        message={pendingMessageFor(['DEC-089', 'DEC-004'])}
      />
    </Section>
  );
}

/** One adult's card: their avatar and name, then each permission they hold over you. */
function ActorCard({ grants }: { grants: GrantView[] }) {
  const zone = useKnownFacilityZone().zone;
  const name = grants[0]?.actorDisplayName || 'Name not available to you';
  return (
    <Card>
      <PersonHeading name={name} personId={grants[0]?.actorPersonId} />
      <View accessibilityRole="list" accessibilityLabel={`What ${name} may do for you`}>
        {grants.map((grant) => (
          <ListRow
            key={grant.grantId}
            title={permissionLabel(grant.permission)}
            detail={`Since ${formatDateTime(grant.effectiveFrom, zone)}${
              grant.effectiveTo ? `, until ${formatDateTime(grant.effectiveTo, zone)}` : ''
            }, ${sourceText(grant.source)}`}
            status={grantStatusLabel(grant, zone)}
          />
        ))}
      </View>
    </Card>
  );
}

const styles = { cards: { gap: spacing.md } } as const;
