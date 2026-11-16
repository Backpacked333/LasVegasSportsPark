/**
 * Results and renewals on SCR-C-03 Home (SPK-UX-003 "results and follow-up", then "renewal
 * opportunities", in that order; ADR-008): one `Carousel` of picture tiles, results first. Each
 * tile is one element named by its words ("Result, Result: Lions 2, Tigers 1, For: Sam, Unread")
 * and opens the item the notice is about, or the notice in the inbox (`useOpenNotice`).
 */
import type { Schema } from '@sportspark/api-client';
import { artworkFor } from '../../artwork/artworkFor';
import { noticeStatus } from '../../features/today/status';
import { Carousel } from '../../ui/Carousel';
import { MediaCard } from '../../ui/MediaCard';
import { Section } from '../../ui/Section';
import { noticeFor, openNoticeHint, useOpenNotice } from './open-notice';

type InboxItem = Schema<'InboxItem'>;

/** Width of one tile in the row. */
export const FOLLOW_UP_TILE_WIDTH = 224;

interface Tile {
  item: InboxItem;
  kind: 'results' | 'renewals';
}

function tileArt(tile: Tile) {
  if (tile.kind === 'renewals')
    return artworkFor({ kind: 'season', title: tile.item.title }, 'square');
  if (tile.item.kind === 'youth_feedback')
    return artworkFor({ kind: 'term', ageMax: 12 }, 'square');
  return artworkFor({ kind: 'game', title: tile.item.title }, 'square');
}

export function FollowUp({
  results,
  renewals,
  names,
}: {
  results: readonly InboxItem[];
  renewals: readonly InboxItem[];
  names: Map<string, string>;
}) {
  const openNotice = useOpenNotice();
  const tiles: Tile[] = [
    ...results.map((item) => ({ item, kind: 'results' as const })),
    ...renewals.map((item) => ({ item, kind: 'renewals' as const })),
  ];
  if (tiles.length === 0) return null;
  const title =
    results.length > 0 && renewals.length > 0
      ? 'Results and renewals'
      : results.length > 0
        ? 'Results'
        : 'Renewals';
  return (
    <Section title={title} variant="carousel" testID="home-follow-up">
      <Carousel
        data={tiles}
        keyExtractor={(tile) => tile.item.attemptId}
        accessibilityLabel={title}
        itemWidth={FOLLOW_UP_TILE_WIDTH}
        renderItem={({ item: tile }) => (
          <MediaCard
            form="tile"
            width={FOLLOW_UP_TILE_WIDTH}
            source={tileArt(tile).source}
            eyebrow={tile.kind === 'results' ? 'Result' : 'Renewal'}
            title={tile.item.title}
            meta={
              noticeFor(tile.item, names)
                ? [noticeFor(tile.item, names).trim().replace(/\.$/, '')]
                : []
            }
            tags={[noticeStatus(tile.item).label]}
            onPress={() => openNotice(tile.item)}
            accessibilityHint={openNoticeHint(tile.item)}
            testID={`home-${tile.kind}-${tile.item.attemptId}`}
          />
        )}
      />
    </Section>
  );
}
