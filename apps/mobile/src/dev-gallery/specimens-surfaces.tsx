/**
 * Gallery specimens of surfaces (ADR-008): Section in its three looks, Card, InfoCard tones,
 * MediaCard in its three forms over the bundled artwork, Carousel, StatTile, ListRow v2, Avatar
 * and AvatarStack, CountBadge, Tag, ProgressSteps, StickyActionBar, Disclosure, SupportDetails and
 * EmptyState with an illustration.
 */
import { useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { activityArtwork, illustrations, type ActivityArt } from '../artwork/manifest';
import { Avatar, AvatarStack } from '../ui/Avatar';
import { Card, Eyebrow } from '../ui/Card';
import { Carousel } from '../ui/Carousel';
import { CountBadge } from '../ui/CountBadge';
import { Disclosure } from '../ui/Disclosure';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { InfoCard, type InfoCardTone } from '../ui/InfoCard';
import { ListRow } from '../ui/ListRow';
import { MediaCard } from '../ui/MediaCard';
import { ProgressSteps } from '../ui/ProgressSteps';
import { Section } from '../ui/Section';
import { StatTile } from '../ui/StatTile';
import { StickyActionBar } from '../ui/StickyActionBar';
import { SupportDetails } from '../ui/SupportDetails';
import { Tag } from '../ui/Tag';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { Caption, inGutter, Row, Specimens } from './specimen';

const PEOPLE = [
  { name: 'Maya Lopez', id: 'maya' },
  { name: 'Leo Lopez', id: 'leo' },
  { name: 'Ana Ruiz', id: 'ana' },
  { name: 'Sam Chen', id: 'sam' },
  { name: 'Kai Ito', id: 'kai' },
];

const INFO_TONES: readonly { tone: InfoCardTone; title: string; message: string }[] = [
  { tone: 'info', title: 'Field change', message: 'Saturday games move to pitch 3.' },
  { tone: 'warning', title: 'Form needed', message: 'Sign the waiver before the first session.' },
  { tone: 'success', title: 'Registered', message: 'Maya is in the U10 Saturday league.' },
  {
    tone: 'danger',
    title: 'Payment failed',
    message: 'Your card was declined. Nothing was charged.',
  },
];

interface Tile {
  art: ActivityArt;
  title: string;
  meta: string;
}
const TILES: readonly Tile[] = [
  { art: 'soccer-youth', title: 'U10 Saturday league', meta: 'Saturdays 9 am' },
  { art: 'futsal-indoor', title: 'Futsal nights', meta: 'Wednesdays 7 pm' },
  { art: 'camp', title: 'Winter camp', meta: '22 to 24 December' },
  { art: 'party', title: 'Birthday parties', meta: 'Weekends' },
];

export function SurfaceSpecimens() {
  return (
    <>
      <SectionSpecimens />
      <CardSpecimens />
      <MediaSpecimens />
      <StatAndRowSpecimens />
      <PeopleAndLabelSpecimens />
      <FlowSpecimens />
    </>
  );
}

function SectionSpecimens() {
  const toast = useToast();
  return (
    <>
      <Section
        title="Section, card look"
        subtitle="With a See all action"
        action={{
          label: 'See all',
          onPress: () => toast.show({ message: 'See all', tone: 'info' }),
        }}
      >
        <ListRow title="Rows in a card are flat" subtitle="With dividers between them" />
        <ListRow title="A second row" />
      </Section>
      <Section title="Section, plain look" variant="plain">
        <Text tone="muted">Content straight on the page, inside the gutter.</Text>
      </Section>
    </>
  );
}

function CardSpecimens() {
  const toast = useToast();
  return (
    <Specimens title="Card and InfoCard" subtitle="Bordered, raised, night, pressable; four tones">
      <Card style={inGutter}>
        <Eyebrow>Bordered card</Eyebrow>
        <Text>The default card with its line border.</Text>
      </Card>
      <Card elevation="raised" style={inGutter}>
        <Eyebrow>Raised card</Eyebrow>
        <Text>An elevation level instead of the border.</Text>
      </Card>
      <Card tone="night" style={inGutter}>
        <Text tone="inverse" variant="headline">
          Night card
        </Text>
        <Text tone="inverse">The pitch at night, for heroes and the pass.</Text>
      </Card>
      <Card
        elevation="card"
        style={inGutter}
        onPress={() => toast.show({ message: 'Card pressed', tone: 'info' })}
      >
        <Text variant="headline">Pressable card</Text>
        <Text tone="muted">One button, named by its words.</Text>
      </Card>
      <Card style={inGutter} disabled onPress={() => undefined}>
        <Text variant="headline">Disabled card</Text>
      </Card>
      {INFO_TONES.map((info) => (
        <InfoCard
          key={info.tone}
          tone={info.tone}
          title={info.title}
          message={info.message}
          action={
            info.tone === 'danger'
              ? { label: 'Try again', onPress: () => toast.show({ message: 'Retrying' }) }
              : undefined
          }
        />
      ))}
    </Specimens>
  );
}

function MediaSpecimens() {
  const toast = useToast();
  const { width } = useWindowDimensions();
  const tileWidth = Math.min(240, Math.round(width * 0.62));
  const open = (title: string) => () => toast.show({ message: `Open ${title}`, tone: 'info' });
  return (
    <>
      <Specimens title="MediaCard" subtitle="Hero, compact; tiles in the carousel below">
        <MediaCard
          form="hero"
          source={activityArtwork['soccer-league'].wide}
          aspectRatio={16 / 9}
          eyebrow="Fall league"
          title="U10 Saturday league"
          meta={['Saturdays 9 am', 'Pitch 2']}
          tags={['Ages 9 to 10']}
          onPress={open('U10 Saturday league')}
          trailing={
            <IconButton
              icon="favorite"
              label="Save U10 Saturday league"
              variant="onMedia"
              onPress={open('saved')}
            />
          }
        />
        <MediaCard
          form="compact"
          source={activityArtwork['kids-class'].square}
          title="Little kickers"
          meta={['Tuesdays 4 pm']}
          tags={['Ages 3 to 5']}
          onPress={open('Little kickers')}
        />
        <MediaCard
          form="compact"
          source={activityArtwork.basketball.square}
          title="Open court"
          meta={['Not pressable: one element with one name']}
        />
      </Specimens>
      <Section title="Carousel" subtitle="MediaCard tiles; snaps card by card" variant="carousel">
        <Carousel
          data={TILES}
          accessibilityLabel="Activities"
          itemWidth={tileWidth}
          keyExtractor={(tile) => tile.art}
          renderItem={({ item }) => (
            <MediaCard
              form="tile"
              width={tileWidth}
              source={activityArtwork[item.art].square}
              aspectRatio={4 / 5}
              title={item.title}
              meta={[item.meta]}
              onPress={open(item.title)}
            />
          )}
        />
      </Section>
    </>
  );
}

function StatAndRowSpecimens() {
  const toast = useToast();
  return (
    <>
      <Specimens title="StatTile" subtitle="Tones">
        <Row>
          <StatTile label="Due" value="$120.00" sublabel="By 1 December" tone="warning" />
          <StatTile label="Paid" value="$480.00" tone="success" />
          <StatTile label="Games" value="8" sublabel="This season" />
        </Row>
        <Row>
          <StatTile label="Credits" value="2" tone="info" />
          <StatTile label="Overdue" value="$40.00" tone="danger" />
        </Row>
      </Specimens>
      <Section title="ListRow" subtitle="Subtitle, value, avatar, icon, status, badge, chevron">
        <ListRow
          title="Maya Lopez"
          subtitle="U10 Saturday league"
          avatar={PEOPLE[0]}
          onPress={() => toast.show({ message: 'Open Maya' })}
        />
        <ListRow title="Balance" value="$120.00" icon="payments" />
        <ListRow
          title="Registration"
          subtitle="Winter camp"
          status={{ tone: 'pending', label: 'Awaiting placement' }}
        />
        <ListRow
          title="Notifications"
          badge={4}
          onPress={() => toast.show({ message: 'Open notifications' })}
        />
        <ListRow
          title="Waiver"
          detail="Signed 2 November"
          badges={[{ tone: 'success', label: 'Signed' }]}
        />
      </Section>
    </>
  );
}

function PeopleAndLabelSpecimens() {
  return (
    <Specimens title="Avatar, CountBadge, Tag" subtitle="Initials only; counts; short labels">
      <Row>
        <Avatar name="Maya Lopez" id="maya" size="sm" />
        <Avatar name="Leo Lopez" id="leo" size="md" />
        <Avatar name="Ana Ruiz" id="ana" size="lg" />
        <AvatarStack people={PEOPLE} max={3} />
      </Row>
      <Row>
        <CountBadge count={1} />
        <CountBadge count={12} accessibilityLabel="12 unread messages" />
        <CountBadge count={240} />
      </Row>
      <Row>
        <Tag label="Ages 6 to 8" />
        <Tag label="Indoor" tone="tonal" icon="home" />
        <Tag label="Saturdays" icon="calendar_month" />
      </Row>
    </Specimens>
  );
}

function FlowSpecimens() {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const steps = ['Player', 'Options', 'Forms', 'Pay'];
  return (
    <>
      <Specimens title="ProgressSteps and StickyActionBar" subtitle="A flow's steps and its action">
        <ProgressSteps steps={steps} current={step} />
        <Caption>{`Step ${step + 1} of ${steps.length}`}</Caption>
      </Specimens>
      <StickyActionBar
        summaryLabel="Total"
        summaryValue="$240.00"
        summaryNote="Includes fees"
        action={{
          label: step < steps.length - 1 ? 'Continue' : 'Start again',
          onPress: () => setStep((s) => (s < steps.length - 1 ? s + 1 : 0)),
        }}
      />
      <StickyActionBar
        summaryLabel="Total"
        summaryValue="$240.00"
        action={{ label: 'Paying', busy: true, onPress: () => undefined }}
      />
      <Specimens title="Disclosure and SupportDetails" subtitle="Folds opened on purpose">
        <Disclosure title="What's included">
          <Text>Ten sessions, a ball and a team shirt.</Text>
        </Disclosure>
        <Disclosure title="Open by default" size="sm" defaultExpanded>
          <Text tone="muted">A small fold that starts open.</Text>
        </Disclosure>
        <SupportDetails
          decisions={['DEC-019']}
          owner="Technical lead"
          errorCode="STALE_REVISION"
          reference="corr-0001"
        />
      </Specimens>
      <Specimens title="EmptyState" subtitle="With an illustration">
        <EmptyState
          source={illustrations['empty-calendar']}
          title="Nothing on the calendar"
          message="Games, sessions and bookings show here once you register."
          action={{
            label: 'Explore activities',
            onPress: () => toast.show({ message: 'Explore' }),
          }}
        />
      </Specimens>
    </>
  );
}
