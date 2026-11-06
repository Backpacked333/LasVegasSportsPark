/**
 * The season a season-scoped Compete screen belongs to, as the page eyebrow ("Compete · Autumn
 * 2026"). It reads the season once (`GET /v1/seasons/{id}`, shared with the season home's cache);
 * while it loads, or when the viewer may not read it, the eyebrow says only "Compete".
 */
import { useApiQuery } from '../../api/useApiQuery';

export function SeasonEyebrow({ seasonId, extra }: { seasonId: string; extra?: string }) {
  const season = useApiQuery({
    path: '/seasons/{id}',
    request: { path: { id: seasonId } },
    enabled: !!seasonId,
    staleTime: 5 * 60_000,
  });
  return (
    <>
      Compete{season.data ? ` · ${season.data.name}` : ''}
      {extra ? ` · ${extra}` : ''}
    </>
  );
}
