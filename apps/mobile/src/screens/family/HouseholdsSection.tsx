/**
 * SCR-C-31 households (SPK-IAM-001 "Households group people for billing, communication and
 * convenience, but household membership alone must not grant authority", §4.5, §4.14):
 * `GET /v1/me/households` lists the households this person belongs to, with the members they may
 * view (themselves and people they hold `view` over) named and the others only counted. The screen
 * says plainly that membership grants nothing; permissions are listed per person.
 */
import type { Schema } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { colors, spacing, type } from '../../ui/theme';
import { Paragraph, SectionHeader } from '../account/components/forms';

type MyHousehold = Schema<'MyHousehold'>;
type Member = MyHousehold['members'][number];

function memberDetail(member: Member): string {
  const parts = [member.isSelf ? 'You' : member.kind === 'child' ? 'Child' : 'Adult'];
  if (member.label) parts.push(member.label);
  return parts.join(', ');
}

export function otherMembersText(count: number): string | null {
  if (count <= 0) return null;
  return `${count} other ${count === 1 ? 'member is' : 'members are'} not shown, because you do not have permission to view them.`;
}

export function HouseholdsSection() {
  const households = useApiQuery({ path: '/me/households' });
  return (
    <View>
      <SectionHeader
        title="Households"
        detail="A household groups people for billing and messages. Being in a household gives nobody any permission."
      />
      <QueryBoundary
        query={households}
        label="your households"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No household yet',
          description: 'The front desk can group your family into a household.',
        }}
      >
        {(data) => (
          <View>
            {data.items.map((household) => (
              <HouseholdCard key={household.id} household={household} />
            ))}
          </View>
        )}
      </QueryBoundary>
    </View>
  );
}

function HouseholdCard({ household }: { household: MyHousehold }) {
  const others = otherMembersText(household.otherMemberCount);
  return (
    <View style={styles.card} testID={`household-${household.id}`}>
      <Text style={styles.title} accessibilityRole="header">
        {household.name}
      </Text>
      <View accessibilityRole="list" accessibilityLabel={`Members of ${household.name}`}>
        {household.members.map((member) => (
          <ListRow key={member.personId} title={member.displayName} detail={memberDetail(member)} />
        ))}
      </View>
      {others ? <Paragraph muted>{others}</Paragraph> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
  },
  title: { ...type.heading, color: colors.text, paddingHorizontal: spacing.lg },
});
