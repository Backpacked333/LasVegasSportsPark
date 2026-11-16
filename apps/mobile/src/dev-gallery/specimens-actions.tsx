/**
 * Gallery specimens of text, actions and feedback (ADR-008): Text variants and tones, Button
 * variants and sizes with busy and disabled, IconButton with a count, Toast and Skeleton.
 */
import { useState } from 'react';
import { Button, type ButtonVariant } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Skeleton, SkeletonCard, SkeletonGroup } from '../ui/Skeleton';
import { Text, TEXT_VARIANTS, type TextTone, type TextVariant } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { Caption, Column, NightBand, Row, ScrimBand, Specimens } from './specimen';

const VARIANTS = Object.keys(TEXT_VARIANTS) as TextVariant[];
const PAGE_TONES: readonly TextTone[] = ['default', 'muted', 'accent', 'danger'];
/** Button variants of the visual system v2 (the first system's `lime` and `ghost-dark` are left out). */
const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  'primary',
  'secondary',
  'tonal',
  'text',
  'destructive',
];

export function ActionSpecimens() {
  return (
    <>
      <TextSpecimens />
      <ButtonSpecimens />
      <IconButtonSpecimens />
      <ToastSpecimens />
      <SkeletonSpecimens />
    </>
  );
}

function TextSpecimens() {
  return (
    <Specimens title="Text" subtitle="Variants, then tones">
      <Column>
        {VARIANTS.map((variant) => (
          <Text key={variant} variant={variant}>
            {variant}
          </Text>
        ))}
      </Column>
      <Row>
        {PAGE_TONES.map((tone) => (
          <Text key={tone} tone={tone}>
            {`Tone ${tone}`}
          </Text>
        ))}
      </Row>
      <ScrimBand>
        <Text tone="onMedia">Tone onMedia</Text>
        <Text tone="onMediaMuted">Tone onMediaMuted</Text>
      </ScrimBand>
      <NightBand>
        <Text tone="inverse">Tone inverse</Text>
      </NightBand>
    </Specimens>
  );
}

function ButtonSpecimens() {
  const [presses, setPresses] = useState(0);
  const press = () => setPresses((n) => n + 1);
  return (
    <Specimens title="Button" subtitle={`Variants, sizes, busy and disabled (${presses} presses)`}>
      <Column>
        {BUTTON_VARIANTS.map((variant) => (
          <Button key={variant} label={`Button ${variant}`} variant={variant} onPress={press} />
        ))}
      </Column>
      <ScrimBand>
        <Button label="Button onMedia" variant="onMedia" onPress={press} />
      </ScrimBand>
      <Caption>Sizes md and lg, block</Caption>
      <Row>
        <Button label="Medium" size="md" onPress={press} />
        <Button label="Large" size="lg" onPress={press} />
      </Row>
      <Button label="Large block" size="lg" block onPress={press} />
      <Caption>Busy and disabled</Caption>
      <Row>
        <Button label="Saving" busy onPress={press} />
        <Button label="Unavailable" disabled onPress={press} />
        <Button label="Disabled" variant="secondary" disabled onPress={press} />
      </Row>
      <Caption>With an icon, and a label that wraps</Caption>
      <Button label="Add a player" icon="person_add" variant="tonal" onPress={press} />
      <Button
        label="A long label that wraps onto a second line at large text sizes"
        variant="secondary"
        onPress={press}
      />
    </Specimens>
  );
}

function IconButtonSpecimens() {
  const toast = useToast();
  const said = (message: string) => () => toast.show({ message, tone: 'info' });
  return (
    <Specimens title="IconButton" subtitle="Plain, tonal, on media; counts in the name">
      <Row>
        <IconButton icon="qr_code_2" label="Facility pass" onPress={said('Facility pass')} />
        <IconButton
          icon="notifications"
          label="Notifications"
          count={3}
          onPress={said('3 unread')}
        />
        <IconButton
          icon="shopping_cart"
          label="Cart"
          variant="tonal"
          count={2}
          countLabel="items"
          onPress={said('2 items')}
        />
        <IconButton
          icon="mail"
          label="Messages"
          variant="tonal"
          count={120}
          onPress={said('99+')}
        />
        <IconButton icon="settings" label="Settings" disabled onPress={said('Settings')} />
      </Row>
      <ScrimBand>
        <Row>
          <IconButton
            icon="favorite"
            label="Save activity"
            variant="onMedia"
            onPress={said('Saved')}
          />
          <IconButton icon="share" label="Share" variant="onMedia" onPress={said('Share')} />
        </Row>
      </ScrimBand>
    </Specimens>
  );
}

function ToastSpecimens() {
  const toast = useToast();
  return (
    <Specimens title="Toast" subtitle="Low-stakes successes only">
      <Row>
        <Button
          label="Show a success toast"
          variant="secondary"
          onPress={() => toast.show({ message: 'Preferences saved', tone: 'success' })}
        />
        <Button
          label="Show an info toast"
          variant="secondary"
          onPress={() => toast.show({ message: 'Copied to the clipboard', tone: 'info' })}
        />
      </Row>
    </Specimens>
  );
}

function SkeletonSpecimens() {
  return (
    <Specimens title="Skeleton" subtitle="Line, block, circle and a card">
      <SkeletonGroup>
        <Row>
          <Skeleton shape="circle" />
          <Column style={{ flex: 1 }}>
            <Skeleton width="70%" />
            <Skeleton width="45%" />
          </Column>
        </Row>
        <Skeleton shape="block" height={80} />
      </SkeletonGroup>
      <SkeletonCard />
    </Specimens>
  );
}
