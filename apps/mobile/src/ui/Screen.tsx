/**
 * Screen frame: the connectivity banner (SCR-C-40) on every screen, then the content. Scrolls so
 * large text never truncates a status (SPK-UX-009). The page takes the theme's page colour; cards
 * sit on it. A button under an open keyboard answers the first tap (the tap is not spent on
 * closing the keyboard), and the scroll indicator stays visible in Legends mode.
 *
 * Under a floating glass tab bar (`BottomBarInsetContext`, set by the tabs navigator) the content
 * scrolls beneath the bar and ends above it: the last control is never covered.
 *
 * v2 (ADR-008), every part optional, so `<Screen>{children}</Screen>` and `scroll={false}` behave
 * exactly as before:
 * - `title`: a large title at the top (`AppHeader`, a header for screen readers), with
 *   `headerActions` beside it. It scrolls with the content.
 * - `onRefresh` + `refreshing`: pull to refresh (`RefreshControl`, in the theme's accent).
 * - `footer`: a sticky area below the scrolling content (a `StickyActionBar`), kept above a
 *   floating tab bar; the content then ends at the footer.
 * - `list` or `sections`: a list screen. The content is a FlatList or SectionList (only what is on
 *   screen is rendered), with the title and `children` above the items as its header. Every
 *   FlatList or SectionList prop passes through except the header, the refresh control and the
 *   content container, which the screen owns.
 * - `listRef` or `sectionsRef`: the FlatList or SectionList itself, for a screen that scrolls it.
 * - `scrollToSection`: in `sections` mode, scrolls the section with that `key` to the top (the day
 *   picked on Calendar). Each new object scrolls, so picking the same section again scrolls back to
 *   it; a key the sections do not have does nothing. It scrolls at once while motion is reduced
 *   (`useMotion`), and a section not yet laid out is reached through its estimated offset.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import {
  FlatList,
  RefreshControl,
  ScrollView,
  SectionList,
  View,
  type DefaultSectionT,
  type FlatListProps,
  type SectionListProps,
} from 'react-native';
import { ConnectivityBanner } from '../connectivity/ConnectivityBanner';
import { OfflineBannerContext } from './offline-banner';
import { AppHeader } from './AppHeader';
import { useMotion } from './motion';
import { makeStyles, spacing, useTheme } from './theme';

/** Height of a bar floating over the bottom of the screen; 0 when the bar is in the layout. */
export const BottomBarInsetContext = createContext(0);

/** What a list screen passes through to its FlatList. */
export type ScreenListProps<ItemT> = Omit<
  FlatListProps<ItemT>,
  'ListHeaderComponent' | 'refreshControl' | 'refreshing' | 'onRefresh' | 'contentContainerStyle'
>;

/** What a sectioned list screen passes through to its SectionList. */
export type ScreenSectionsProps<ItemT, SectionT = DefaultSectionT> = Omit<
  SectionListProps<ItemT, SectionT>,
  'ListHeaderComponent' | 'refreshControl' | 'refreshing' | 'onRefresh' | 'contentContainerStyle'
>;

export interface ScreenProps<ItemT = unknown, SectionT = DefaultSectionT> {
  /** The content; above the items in list mode. */
  children?: ReactNode;
  /** Scroll the content (default). Ignored in list mode, where the list scrolls. */
  scroll?: boolean;
  /** A large title at the top, announced as a header. */
  title?: string;
  /** Controls beside the title (icon buttons). */
  headerActions?: ReactNode;
  /** Pull to refresh: called when the person pulls the content down. */
  onRefresh?: () => void;
  /** A refresh is in progress (the spinner shows). */
  refreshing?: boolean;
  /** A sticky area under the content, above a floating tab bar. */
  footer?: ReactNode;
  /** List mode: a FlatList. */
  list?: ScreenListProps<ItemT>;
  /** List mode: a SectionList (when both are given, `sections` wins). */
  sections?: ScreenSectionsProps<ItemT, SectionT>;
  /** The FlatList of `list` mode. */
  listRef?: Ref<FlatList<ItemT>>;
  /** The SectionList of `sections` mode. */
  sectionsRef?: Ref<SectionList<ItemT, SectionT>>;
  /** Scrolls the section with this `key` to the top; each new object scrolls again. */
  scrollToSection?: { key: string } | null;
}

/** Sets a ref the caller gave, whichever kind it is. */
function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export function Screen<ItemT = unknown, SectionT = DefaultSectionT>({
  children,
  scroll = true,
  title,
  headerActions,
  onRefresh,
  refreshing = false,
  footer,
  list,
  sections,
  listRef,
  sectionsRef,
  scrollToSection,
}: ScreenProps<ItemT, SectionT>): ReactElement {
  const { dark, colors } = useTheme();
  const styles = useStyles();
  const motion = useMotion();
  const sectionList = useRef<SectionList<ItemT, SectionT> | null>(null);
  const setSectionList = useCallback(
    (node: SectionList<ItemT, SectionT> | null) => {
      sectionList.current = node;
      assignRef(sectionsRef, node);
    },
    [sectionsRef],
  );
  const sectionKeys = sections?.sections.map((section) => (section as { key?: string }).key);
  // Read when a request comes: only a new request scrolls, with the motion setting of that moment.
  const latest = useRef({ sectionKeys, reduced: motion.reduced });
  latest.current = { sectionKeys, reduced: motion.reduced };
  useEffect(() => {
    if (!scrollToSection) return;
    const sectionIndex = latest.current.sectionKeys?.indexOf(scrollToSection.key) ?? -1;
    if (sectionIndex < 0) return;
    sectionList.current?.scrollToLocation({
      sectionIndex,
      itemIndex: 0,
      viewOffset: 0,
      animated: !latest.current.reduced,
    });
  }, [scrollToSection]);
  const bottomBar = useContext(BottomBarInsetContext);
  // With a footer the footer stands on the bar; the content ends at the footer.
  const contentInset = footer ? 0 : bottomBar;
  const header = title ? <AppHeader title={title} actions={headerActions} /> : null;
  const refreshControl = onRefresh ? (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.primary}
      colors={[colors.primary]}
      progressBackgroundColor={colors.background}
    />
  ) : undefined;
  const scrollProps = {
    contentContainerStyle: [
      styles.content,
      contentInset > 0 && { paddingBottom: spacing.xl + contentInset },
    ],
    scrollIndicatorInsets: { bottom: contentInset },
    keyboardShouldPersistTaps: 'handled' as const,
    indicatorStyle: dark ? ('white' as const) : ('black' as const),
    refreshControl,
  };
  const listHeader =
    header || children ? (
      <>
        {header}
        {children}
      </>
    ) : null;

  let body: ReactNode;
  if (sections) {
    body = (
      <SectionList<ItemT, SectionT>
        // A section not laid out yet: go to its estimated place, the next request lands exactly.
        onScrollToIndexFailed={({ averageItemLength, index }) =>
          sectionList.current
            ?.getScrollResponder()
            ?.scrollTo({ y: averageItemLength * index, animated: !motion.reduced })
        }
        {...sections}
        {...scrollProps}
        ref={setSectionList}
        ListHeaderComponent={listHeader}
      />
    );
  } else if (list) {
    body = (
      <FlatList<ItemT> {...list} {...scrollProps} ref={listRef} ListHeaderComponent={listHeader} />
    );
  } else if (scroll) {
    body = (
      <ScrollView {...scrollProps}>
        {header}
        {children}
      </ScrollView>
    );
  } else {
    body = (
      <View style={[styles.root, contentInset > 0 && { paddingBottom: contentInset }]}>
        {header}
        {children}
      </View>
    );
  }

  return (
    <OfflineBannerContext.Provider value>
      <View style={styles.root}>
        <ConnectivityBanner />
        {footer ? <View style={styles.root}>{body}</View> : body}
        {footer ? (
          <View style={bottomBar > 0 ? { paddingBottom: bottomBar } : null}>{footer}</View>
        ) : null}
      </View>
    </OfflineBannerContext.Provider>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.page },
  content: { flexGrow: 1, paddingTop: spacing.xs, paddingBottom: spacing.xl },
}));
