/**
 * "Picked for <child>" on Explore (SCR-C-07; ADR-008 visual system v2): published activities whose
 * age band fits a family member the account may register, from
 * `GET /v1/me/offering-suggestions?participantPersonId=`, as a row of picture tiles. The API
 * suggests by age on each activity's reference date only, with no other profiling, and a
 * suggestion is never an eligibility decision: the activity's registration options decide that
 * when registering (SPK-REG-002). The person is chosen in screen state, never in a route (§4.14),
 * and only the given name is shown.
 *
 * States: nothing while the family is loading or when nobody can be registered; loading; empty
 * (nothing published fits); no date of birth recorded (`basis: date_of_birth_unknown`); error with
 * "Try again" (the code in "Details for support"); not available (protected NOT_FOUND or
 * ACCESS_DENIED); offline with nothing cached.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import { formatDateOnly } from '../../features/registration/format';
import { useParticipants } from '../../features/registration/participants';
import { registrationRoutes } from '../../features/registration/routes';
import { Carousel } from '../../ui/Carousel';
import { ChipRow } from '../../ui/Chip';
import { MediaCard } from '../../ui/MediaCard';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';
import { KIND_WORD, offeringCardLabel, offeringCardLine } from './offering-look';

/** How many suggestions are asked for (the API allows up to 20). */
export const SUGGESTIONS_SHOWN = 3;

export function PickedFor() {
  const styles = useStyles();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const tileWidth = Math.min(240, Math.round(width * 0.62));
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
  const note = (words: string) => (
    <Text variant="callout" tone="muted" style={styles.gutter}>
      {words}
    </Text>
  );
  return (
    <Section title={`Picked for ${person.displayName}`} variant="carousel" testID="picked-for">
      {people.length > 1 ? (
        <ChipRow
          mode="single"
          label="Suggestions for"
          options={people.map((p) => ({ value: p.personId, label: p.displayName }))}
          value={person.personId}
          onChange={(value) => setChosen(value)}
          style={styles.people}
        />
      ) : null}
      {data === undefined ? (
        <View style={styles.gutter}>
          {suggestions.error ? (
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
          )}
        </View>
      ) : data.basis === 'date_of_birth_unknown' ? (
        note(
          `No date of birth is recorded for ${person.displayName}, so nothing can be suggested by age. The front desk can add it.`,
        )
      ) : data.items.length === 0 ? (
        note(`Nothing published right now fits ${person.displayName}'s age.`)
      ) : (
        <Carousel
          data={data.items}
          accessibilityLabel={`Picked for ${person.displayName}`}
          itemWidth={tileWidth}
          keyExtractor={(item) => item.offering.id}
          renderItem={({ item: { offering, reason } }) => {
            const why = `${person.displayName} is ${reason.ageYears} on ${formatDateOnly(reason.referenceDate)}`;
            return (
              <MediaCard
                form="tile"
                width={tileWidth}
                source={artworkFor(offering, 'square').source}
                eyebrow={KIND_WORD[offering.kind]}
                title={offering.name}
                meta={[offeringCardLine(offering)]}
                accessibilityLabel={offeringCardLabel(offering, [why])}
                onPress={() => router.push(registrationRoutes.offering(offering.id))}
                accessibilityHint="Opens the activity"
                testID={`suggestion-${offering.id}`}
              />
            );
          }}
        />
      )}
      {note('Suggested by age only. Whether someone can take part is checked when you register.')}
    </Section>
  );
}

const useStyles = makeStyles(() => ({
  gutter: { paddingHorizontal: layout.gutter },
  people: { paddingBottom: spacing.xs },
}));
