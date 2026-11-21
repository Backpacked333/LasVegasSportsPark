/**
 * "Picked for <child>", last on SCR-C-03 Home (ADR-008; the same suggestions as Explore): published
 * activities whose age band fits the first family member the account may register, from
 * `GET /v1/me/offering-suggestions?participantPersonId=`. The API suggests by age only, and a
 * suggestion is never an eligibility decision (SPK-REG-002): registering checks that. Only the
 * given name is shown; the person is never in a route (§4.14).
 *
 * The redesign (handoff 1b) shows one compact card, "Picked for Maya" above the activity, not
 * something the person must act on: it appears only once there is something to suggest. While it
 * loads, when nothing fits, when no date of birth is recorded or when the read fails, Home shows
 * nothing here (Explore shows those states in full).
 */
import type { Schema } from '@sportspark/api-client';
import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import { registrationRoutes } from '../../features/registration/routes';
import { MediaCard } from '../../ui/MediaCard';
import { layout, makeStyles, spacing } from '../../ui/theme';

/** How many suggestions are asked for (the first is shown). */
export const HOME_SUGGESTIONS = 3;

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
  const first = suggestions.data?.items[0];
  if (suggestions.data?.basis === 'date_of_birth_unknown' || !first) return null;
  const { offering, reason } = first;
  return (
    <View style={styles.box} testID="home-picked-for">
      <MediaCard
        form="compact"
        source={artworkFor(offering, 'square').source}
        eyebrow={`Picked for ${name}`}
        title={offering.name}
        meta={[`${name} is ${reason.ageYears}. Suggested by age only.`]}
        onPress={() => router.push(registrationRoutes.offering(offering.id) as Href)}
        accessibilityHint="Opens the activity details. Whether someone can take part is checked when you register."
        testID={`home-suggestion-${offering.id}`}
      />
    </View>
  );
}

const useStyles = makeStyles(() => ({
  box: { paddingHorizontal: layout.gutter, marginTop: spacing.xl - 4, marginBottom: spacing.lg },
}));
