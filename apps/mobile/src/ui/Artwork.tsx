/**
 * Artwork: the one way the customer app draws a bundled photo or illustration (ADR-008 imagery).
 * An `expo-image` view at a fixed aspect ratio, on the `skeleton` fill until the image has
 * decoded, with rounded `image` corners unless `rounded={false}`.
 *
 * Artwork is always decorative: hidden from VoiceOver and TalkBack (`accessible={false}`,
 * `importantForAccessibility="no-hide-descendants"`, `accessibilityElementsHidden`). The card or
 * text next to it carries the meaning (SPK-UX-009), so no image ever needs a description and none
 * is read out. Images contain no text, faces or logos (ADR-008).
 *
 * The image fades in over the `base` duration only when motion is not reduced (`useMotion()`);
 * with reduced motion, and in every test, it appears at once.
 *
 * `source` is what the caller passes: a `require()` result from the artwork manifest or an
 * `ImageSource`. This component never imports the manifest itself.
 */
import { Image, type ImageContentFit, type ImageSource } from 'expo-image';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useMotion } from './motion';
import { continuousCorners, makeStyles, radius } from './theme';

export type ArtworkSource = ImageSource | number;

export interface ArtworkProps {
  source: ArtworkSource;
  /** Width divided by height; 16:10 by default. */
  aspectRatio?: number;
  contentFit?: ImageContentFit;
  /** Rounded `image` corners (default); off for artwork that fills a card's own rounded top. */
  rounded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Artwork({
  source,
  aspectRatio = 16 / 10,
  contentFit = 'cover',
  rounded = true,
  style,
  testID,
}: ArtworkProps) {
  const styles = useStyles();
  const motion = useMotion();
  const fade = motion.reduced ? 0 : motion.duration('base');
  return (
    <View
      style={[styles.frame, rounded && styles.rounded, { aspectRatio }, style]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Image
        source={source}
        style={styles.image}
        contentFit={contentFit}
        transition={fade}
        accessible={false}
      />
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  // The skeleton fill is the placeholder colour while the image decodes.
  frame: { width: '100%', overflow: 'hidden', backgroundColor: colors.skeleton },
  rounded: { borderRadius: radius.image, ...continuousCorners },
  image: { width: '100%', height: '100%' },
}));
