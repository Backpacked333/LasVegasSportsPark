/**
 * Gallery specimens of inputs and sheets (ADR-008): Sheet, TextField and SearchField, Select,
 * DateField and DateRangeField, ChoiceList, SwitchRow, Chip and ChipRow, SegmentedControl and
 * DateStrip. Each keeps its own value, so every specimen can be tried.
 *
 * On a device a sheet is drawn by the bottom-sheet host at the root of the app, outside the
 * gallery's local theme: its content there follows the app's theme (on the web and in tests it
 * follows the gallery's).
 */
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useNow } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { Chip, ChipRow } from '../ui/Chip';
import { ChoiceList, type ChoiceOption } from '../ui/ChoiceList';
import { DateField, DateRangeField, type DateRange } from '../ui/DateField';
import { todayIn, DateStrip } from '../ui/DateStrip';
import { SearchField, TextField } from '../ui/Field';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';
import { Sheet } from '../ui/Sheet';
import { SwitchRow } from '../ui/SwitchRow';
import { Text } from '../ui/Text';
import { Caption, Column, Row, Specimens } from './specimen';

type Sport = 'soccer' | 'futsal' | 'basketball';
const SPORTS: readonly ChoiceOption<Sport>[] = [
  { value: 'soccer', label: 'Soccer', description: 'Outdoor pitches' },
  { value: 'futsal', label: 'Futsal', description: 'Indoor court' },
  { value: 'basketball', label: 'Basketball', trailing: '$40' },
];

type Day = 'sat' | 'sun' | 'wed';
const DAYS = [
  { value: 'sat', label: 'Sat', accessibilityLabel: 'Saturday' },
  { value: 'sun', label: 'Sun', accessibilityLabel: 'Sunday' },
  { value: 'wed', label: 'Wed', accessibilityLabel: 'Wednesday', disabled: true },
] as const;

type Extra = 'kit' | 'photos' | 'insurance';
const EXTRAS: readonly ChoiceOption<Extra>[] = [
  { value: 'kit', label: 'Team kit', trailing: '$35' },
  { value: 'photos', label: 'Team photos', trailing: '$12' },
  {
    value: 'insurance',
    label: 'Injury cover',
    description: 'Not offered this season',
    disabled: true,
  },
];

export function InputSpecimens() {
  return (
    <>
      <SheetSpecimens />
      <FieldSpecimens />
      <SelectAndDateSpecimens />
      <ChoiceSpecimens />
      <ChipSpecimens />
      <SegmentAndDateStripSpecimens />
    </>
  );
}

function SheetSpecimens() {
  const [open, setOpen] = useState(false);
  const [sport, setSport] = useState<Sport | null>('soccer');
  const trigger = useRef<View>(null);
  return (
    <Specimens title="Sheet" subtitle="In-screen choices; focus returns to the trigger">
      <View ref={trigger} collapsable={false}>
        <Button label="Open a sheet" variant="secondary" onPress={() => setOpen(true)} />
      </View>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Filters"
        returnFocusTo={trigger}
        footer={<Button label="Done" size="lg" block onPress={() => setOpen(false)} />}
      >
        <ChoiceList
          mode="single"
          label="Sport"
          options={SPORTS}
          value={sport}
          onChange={setSport}
        />
      </Sheet>
    </Specimens>
  );
}

function FieldSpecimens() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('maya@example');
  const [query, setQuery] = useState('');
  return (
    <Specimens title="Fields" subtitle="TextField with hint, required and error; SearchField">
      <TextField
        label="Player name"
        hint="As it appears on the ID"
        required
        value={name}
        onChangeText={setName}
      />
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        error={email.includes('.') ? null : 'Enter an email address like name@example.com.'}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <TextField
        label="Facility"
        value="Las Vegas Sports Park"
        onChangeText={() => undefined}
        editable={false}
      />
      <SearchField label="Search activities" value={query} onChangeText={setQuery} />
    </Specimens>
  );
}

function SelectAndDateSpecimens() {
  const [sport, setSport] = useState<Sport | null>(null);
  const [date, setDate] = useState<string | null>('2026-11-21');
  const [range, setRange] = useState<DateRange>({ start: '2026-12-21', end: '2026-12-18' });
  return (
    <Specimens title="Select and dates" subtitle="A field that opens a sheet; date and range">
      <Select label="Sport" options={SPORTS} value={sport} onChange={setSport} />
      <Select label="Season" options={SPORTS} value="futsal" onChange={() => undefined} disabled />
      <DateField label="Date of birth" value={date} onChange={setDate} />
      <DateRangeField
        label="Camp week"
        hint="The end comes before the start here, to show the error"
        value={range}
        onChange={setRange}
      />
    </Specimens>
  );
}

function ChoiceSpecimens() {
  const [sport, setSport] = useState<Sport | null>('futsal');
  const [extras, setExtras] = useState<Extra[]>(['kit']);
  const [reminders, setReminders] = useState(true);
  const [sms, setSms] = useState(false);
  return (
    <Specimens title="ChoiceList and SwitchRow" subtitle="Radio cards, checkbox cards, switches">
      <ChoiceList mode="single" label="Sport" options={SPORTS} value={sport} onChange={setSport} />
      <ChoiceList
        mode="multiple"
        label="Extras"
        hint="Choose any"
        options={EXTRAS}
        value={extras}
        onChange={setExtras}
      />
      <ChoiceList
        mode="single"
        label="Payment plan"
        options={SPORTS}
        value={null}
        onChange={() => undefined}
        error="Choose a plan to continue."
      />
      <SwitchRow
        label="Game reminders"
        description="The evening before each game"
        value={reminders}
        onChange={setReminders}
      />
      <SwitchRow label="Text messages" value={sms} onChange={setSms} />
      <SwitchRow label="Essential notices" value onChange={() => undefined} disabled />
    </Specimens>
  );
}

function ChipSpecimens() {
  const [day, setDay] = useState<Day | null>('sat');
  const [sports, setSports] = useState<Sport[]>(['soccer']);
  const [saved, setSaved] = useState(false);
  return (
    <Specimens title="Chip and ChipRow" subtitle="Action chips, single and multiple choice">
      <Row>
        <Chip label="Filters" icon="tune" onPress={() => undefined} />
        <Chip label="Saved" icon="favorite" selected={saved} onPress={() => setSaved((s) => !s)} />
        <Chip label="Closed" disabled onPress={() => undefined} />
      </Row>
      <Caption>Single, can be cleared</Caption>
      <ChipRow
        mode="single"
        label="Day"
        options={DAYS}
        value={day}
        onChange={setDay}
        allowEmpty
        inset={0}
      />
      <Caption>Multiple</Caption>
      <ChipRow
        mode="multiple"
        label="Sport"
        options={SPORTS}
        value={sports}
        onChange={setSports}
        inset={0}
      />
    </Specimens>
  );
}

function SegmentAndDateStripSpecimens() {
  const now = useNow();
  const today = todayIn(now, 'America/Los_Angeles');
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [range, setRange] = useState<'week' | 'month'>('week');
  const [day, setDay] = useState(today);
  return (
    <Specimens title="SegmentedControl and DateStrip" subtitle="Tabs, radio, a week of days">
      <SegmentedControl
        label="Show"
        segments={[
          { value: 'upcoming', label: 'Upcoming' },
          { value: 'past', label: 'Past' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <SegmentedControl
        label="Range"
        pattern="radio"
        segments={[
          { value: 'week', label: 'Week' },
          { value: 'month', label: 'Month' },
        ]}
        value={range}
        onChange={setRange}
      />
      <Column>
        <DateStrip
          value={day}
          onChange={setDay}
          today={now}
          timeZone="America/Los_Angeles"
          markedDates={[today]}
          markedLabel="has activities"
        />
        <Text variant="footnote" tone="muted">{`Selected ${day}`}</Text>
      </Column>
    </Specimens>
  );
}
