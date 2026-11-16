/**
 * Section frame and per-section read state for screens built from several reads (SCR-C-03 Home,
 * SCR-C-18 Schedule, SCR-C-20 detail). Each section shows its own SPK-UX-008 state, so one failed
 * read never hides the others: loading, error with the API's code and recovery, offline with
 * nothing cached, and a protected NOT_FOUND or a denial as "not available" without implying a
 * record exists (§4.10). The page shows the age of what it displays once, not per section.
 *
 * `Section` and `Caption` are thin adapters over the visual system v2 in `src/ui` (ADR-008,
 * Phase 3), keeping their props and accessible output while screens move to `src/ui` directly.
 * `SectionQueryState` and `oldestUpdate` live in `read-state.tsx`, which is not a kit.
 */
import type { ReactNode } from 'react';
import { Section as UiSection } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { layout, makeStyles } from '../../ui/theme';

// The per-section read state moved out of the kit (`read-state.tsx`); re-exported for old imports.
export { oldestUpdate, SectionQueryState, type ReadLike } from './read-state';

export function Section({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  // Edge to edge (`ui/Section` without its card): the rows and state cards inside keep their own
  // gutter, as they did on the plain page.
  return (
    <UiSection title={title} variant="carousel" testID={testID}>
      {children}
    </UiSection>
  );
}

export function Caption({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles();
  return (
    <Text variant="caption" tone="muted" style={styles.caption} testID={testID}>
      {children}
    </Text>
  );
}

const useStyles = makeStyles(() => ({
  caption: { paddingHorizontal: layout.gutter },
}));
