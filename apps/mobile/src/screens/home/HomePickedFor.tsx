/**
 * "Picked for <child>", last on SCR-C-03 Home (ADR-008; the same suggestions as Explore): published
 * activities whose age band fits the first family member the account may register, from
 * `GET /v1/me/offering-suggestions?participantPersonId=`. The API suggests by age only, and a
 * suggestion is never an eligibility decision (SPK-REG-002): registering checks that. Only the
 * given name is shown; the person is never in a route (§4.14).
 *
 * A strip of suggestions, not something the person must act on: it appears only once there is
 * something to suggest. While it loads, when nothing fits, when no date of birth is recorded or
 * when the read fails, Home shows nothing here (Explore shows those states in full).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import { registrationRoutes } from '../../features/registration/routes';
import { Carousel } from '../../ui/Carousel';
import { MediaCard } from '../../ui/MediaCard';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

/** How many suggestions are asked for. */
export const HOME_SUGGESTIONS = 3;
const TILE_WIDTH = 224;

/** The first person the account may register who is not the account holder, or null. */
export function pickedForPerson(me: Schema<'Me'> | undefined): string | null {
  const selfId = me?.principal.personId ?? null;
  return (
    me?.authorities.find((a) => a.subjectPersonId !== selfId && a.permissions.includes('register'))
      ?.subjectPersonId ?? null
  );
}

export function HomePickedFor({ personId, name }: { personId: string; name: string }) {
  const router = useRouter();
  const styles = useStyles();
  const suggestions = useApiQuery({
    path: '/me/offering-suggestions',
    request: { query: { participantPersonId: personId, limit: HOME_SUGGESTIONS } },
    staleTime: 60_000,
  });
  const items = suggestions.data?.items ?? [];
  if (suggestions.data?.basis === 'date_of_birth_unknown' || items.length === 0) return null;
  const title = `Picked for ${name}`;
  return (
    <Section title={title} variant="carousel" testID="home-picked-for">
      <Carousel
        data={items}
        keyExtractor={({ offering }) => offering.id}
        accessibilityLabel={title}
        itemWidth={TILE_WIDTH}
        renderItem={({ item: { offering, reason } }) => (
          <MediaCard
            form="tile"
            width={TILE_WIDTH}
            source={artworkFor(offering, 'square').source}
            title={offering.name}
            meta={[`${name} is ${reason.ageYears}`]}
            onPress={() => router.push(registrationRoutes.offering(offering.id) as Href)}
            accessibilityHint="Opens the activity details"
            testID={`home-suggestion-${offering.id}`}
          />
        )}
      />
      <Text variant="footnote" tone="muted" style={styles.note}>
        Suggested by age only. Whether someone can take part is checked when you register.
      </Text>
    </Section>
  );
}

const useStyles = makeStyles(() => ({
  note: { paddingHorizontal: layout.gutter, paddingTop: spacing.xs },
}));
