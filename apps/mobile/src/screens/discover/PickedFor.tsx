/**
 * "Picked for <child>" on Discover (SCR-C-07; park UI redesign): published offerings whose age
 * band fits a family member the account may register, from
 * `GET /v1/me/offering-suggestions?participantPersonId=`. The API suggests by age on each
 * offering's reference date only, with no other profiling, and a suggestion is never an
 * eligibility decision: the offering's registration options decide that when registering
 * (SPK-REG-002). The person is chosen in screen state, never in a route (§4.14), and only the
 * given name is shown.
 *
 * States: nothing while the family is loading or when nobody can be registered; loading; empty
 * (nothing published fits); no date of birth recorded (`basis: date_of_birth_unknown`); error with
 * the code and "Try again"; not available (protected NOT_FOUND or ACCESS_DENIED); offline with
 * nothing cached.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatDateOnly } from '../../features/registration/format';
import { useParticipants } from '../../features/registration/participants';
import { promotionBadges } from '../../features/registration/promotions';
import { registrationRoutes } from '../../features/registration/routes';
import { registrationWindowStatus } from '../../features/registration/status';
import { Body } from '../../features/registration/ui';
import { Card, Eyebrow } from '../../ui/Card';
import { ListRow } from '../../ui/ListRow';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { colors, fonts, MIN_TOUCH_SIZE, radius, spacing, type } from '../../ui/theme';
import { KIND_LOOK, offeringSummary } from './offering-look';

/** How many suggestions are asked for (the API allows up to 20). */
export const SUGGESTIONS_SHOWN = 3;

export function PickedFor() {
  const router = useRouter();
  const { participants } = useParticipants();
  // Family members the account may register (the API checks again): never the adult themselves.
  const people = participants.filter((p) => !p.self && p.permissions.includes('register'));
  const [chosen, setChosen] = useState<string | null>(null);
  const person = people.find((p) => p.personId === chosen) ?? people[0] ?? null;
  const suggestions = useApiQuery({
    path: '/me/offering-suggestions',
    request: {
      query: { participantPersonId: person?.personId ?? '', limit: SUGGESTIONS_SHOWN },
    },
    enabled: person !== null,
    staleTime: 60_000,
  });
  if (!person) return null;
  const data = suggestions.data;
  return (
    <Card testID="picked-for">
      <Eyebrow>{`Picked for ${person.displayName}`}</Eyebrow>
      {people.length > 1 ? (
        <View
          style={styles.people}
          accessibilityRole="radiogroup"
          accessibilityLabel="Suggestions for"
        >
          {people.map((p) => {
            const checked = p.personId === person.personId;
            return (
              <Pressable
                key={p.personId}
                accessibilityRole="radio"
                accessibilityLabel={p.displayName}
                accessibilityState={{ checked }}
                onPress={() => setChosen(p.personId)}
                style={[styles.chip, checked && styles.chipOn]}
                testID={`picked-for-${p.personId}`}
              >
                <Text style={[styles.chipText, checked && styles.chipTextOn]}>
                  {checked ? `✓ ${p.displayName}` : p.displayName}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {data === undefined ? (
        suggestions.error ? (
          <QueryErrorView
            error={suggestions.error}
            onRetry={() => void suggestions.refetch()}
            unavailable={{
              title: 'Suggestions not available',
              description: 'Browse the activities below instead.',
            }}
          />
        ) : (
          <StateView variant="loading" label={`suggestions for ${person.displayName}`} />
        )
      ) : data.basis === 'date_of_birth_unknown' ? (
        <Body muted>
          {`No date of birth is recorded for ${person.displayName}, so nothing can be suggested by age. The front desk can add it.`}
        </Body>
      ) : data.items.length === 0 ? (
        <Body muted>{`Nothing published right now fits ${person.displayName}'s age.`}</Body>
      ) : (
        <View accessibilityRole="list">
          {data.items.map(({ offering, reason }) => (
            <ListRow
              key={offering.id}
              title={offering.name}
              detail={`${offeringSummary(offering)} · ${person.displayName} is ${reason.ageYears} on ${formatDateOnly(reason.referenceDate)}`}
              status={registrationWindowStatus(offering)}
              badges={promotionBadges(offering)}
              icon={KIND_LOOK[offering.kind][0]}
              iconTone={[KIND_LOOK[offering.kind][1], colors.primaryText]}
              onPress={() => router.push(registrationRoutes.offering(offering.id))}
              accessibilityHint="Opens the activity details"
              testID={`suggestion-${offering.id}`}
            />
          ))}
        </View>
      )}
      <Body muted>
        Suggested by age only. Whether someone can take part is checked when you register.
      </Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  people: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingVertical: spacing.sm },
  chip: {
    minHeight: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    paddingHorizontal: 13,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chipOn: { backgroundColor: colors.night, borderColor: colors.night },
  chipText: { ...type.caption, ...fonts.bold, color: colors.text },
  chipTextOn: { color: colors.primaryText },
});
