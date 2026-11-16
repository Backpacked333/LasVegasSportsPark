/**
 * PA-11, SPK-UX-011 (**Proposed**; open values DEC-107): the copy guard. Customers see plain
 * words from one vocabulary (`src/copy/vocabulary.ts`), and internal identifiers only inside the
 * "Details for support" fold (`SupportDetails`).
 *
 * The guard parses every `.ts` and `.tsx` file under `src` and `app` with the TypeScript compiler
 * (not tests, test helpers, `*.web.ts`, `src/dev`, `src/demo`, `src/dev-gallery` or `src/copy`),
 * collects the text customers can see or hear (`customer-text.ts` says exactly which), and looks
 * for the banned terms. Each finding is one entry, `relativePath :: term :: snippet`.
 *
 * The ratchet. `src/copy/customer-words.baseline.json` lists today's findings, sorted, with a
 * blank line between files so each journey removes its own files' lines. The test fails when:
 * - a finding is not in the list: use the customer word from `vocabulary.ts`, or move the code
 *   into `SupportDetails`;
 * - a listed entry no longer occurs: delete it from the list.
 * So the list only shrinks, until it is empty.
 *
 * Updating the list: `UPDATE_COPY_BASELINE=1 pnpm exec jest src/copy` (from `apps/mobile`)
 * rewrites it. With a list already present it only drops stale entries; a new finding still fails.
 * Without one it writes every finding (how the first list was made).
 */
import * as fs from 'fs';
import * as path from 'path';
import { BANNED_CUSTOMER_TERMS, KEPT_PHRASES, keptPhrasePattern } from '../vocabulary';
import {
  bannedIn,
  beyond,
  compare,
  currentEntries,
  customerTexts,
  formatBaseline,
  isGuardedFile,
  scanSource,
  snippetOf,
} from './customer-text';

const APP_ROOT = path.resolve(__dirname, '../../..');
const BASELINE = path.join(APP_ROOT, 'src/copy/customer-words.baseline.json');

function terms(source: string, fileName = 'src/screens/example/Example.tsx'): string[] {
  return scanSource(source, fileName).map((f) => f.term);
}

describe('PA-11 SPK-UX-011 copy guard: what counts as customer text', () => {
  it('PA-11: JSX text is caught', () => {
    expect(terms('const A = () => <Text>Your basket is empty</Text>;')).toEqual(['basket']);
  });

  it('PA-11: a title prop is caught', () => {
    expect(terms('const A = () => <Section title="Household members" />;')).toEqual(['household']);
  });

  it('PA-11: a display prop given an expression is caught, and so is a …Label prop', () => {
    const source = `const A = () => (
      <>
        <Row title={ok ? 'Fixtures' : 'Nothing'} />
        <Button submitLabel={'Pay obligation'} />
      </>
    );`;
    expect(terms(source)).toEqual(['fixture', 'obligation']);
  });

  it('PA-11: a template literal with an expression is caught', () => {
    const source = 'const A = () => <Button label={`Pay ${formatMoney(due)} for the quote`} />;';
    expect(scanSource(source, 'src/screens/example/Example.tsx')).toEqual([
      { term: 'quote', snippet: 'Pay … for the quote' },
    ]);
  });

  it('PA-11: text inside SupportDetails is ignored, its props included', () => {
    const source = `const A = () => (
      <View>
        <SupportDetails decisions={['DEC-019']} lines={[{ label: 'Basket', value: id }]}>
          <Text>DEC-019 basket</Text>
        </SupportDetails>
        <ui.SupportDetails errorCode="SPK-PAY-007" />
      </View>
    );`;
    expect(terms(source)).toEqual([]);
  });

  it('PA-11: a kept phrase is allowed, even with a banned word in it', () => {
    // The guard removes a kept phrase before it looks for banned terms.
    const kept = [keptPhrasePattern('Your basket is ready'), keptPhrasePattern('Fixture for …')];
    expect(bannedIn('Your basket is ready', kept)).toEqual([]);
    expect(bannedIn('Fixture for …', kept)).toEqual([]);
    // A literal after a trailing "…" is still read; so is the rest of the string.
    expect(bannedIn('Fixture for the household', kept).map((f) => f.term)).toEqual(['household']);
    expect(bannedIn('Your basket is ready. Quote below.', kept).map((f) => f.term)).toEqual([
      'quote',
    ]);
    // The journeys.md section 3 phrases and the recovery words pass as written.
    const source = `const A = () => (
      <>
        <Text>Payment outcome being confirmed. Do not pay again.</Text>
        <Button label="Check again" />
        <Text>{\`Place offered. Accept by \${time}.\`}</Text>
      </>
    );`;
    expect(terms(source)).toEqual([]);
  });

  it('PA-11: testID, href, key, route strings and comments are ignored', () => {
    const source = `const A = () => (
      // The basket screen (SPK-REG-001).
      <Link href="/registration/basket/1" testID="basket-link" key="basket">
        {/* quote */}
        <Pressable onPress={() => router.push('/registration/quote/' + id)} />
      </Link>
    );`;
    expect(terms(source)).toEqual([]);
  });

  it('PA-11: codes in visible text are caught: SCR-, SPK-, DEC-, POL-, PA- with a digit, §', () => {
    const source = `const A = () => (
      <>
        <Text>It depends on DEC-019 and POL-046.</Text>
        <Text>See SPK-UX-002, SCR-C-19 and §2.2.</Text>
        <Text>PA-11 applies; a PA-system is not a code.</Text>
      </>
    );`;
    expect(terms(source).sort()).toEqual(['DEC-', 'PA-', 'POL-', 'SCR-', 'SPK-', '§'].sort());
  });

  it('PA-11: object props in a display slot, announcements and navigator titles are read', () => {
    const source = `const A = () => (
      <>
        <Stack.Screen name="fixtures/[id]" options={{ title: 'Fixture' }} />
        <QueryBoundary empty={{ title: 'No offerings', description: '' }} />
        <LiveRegion announcement={sentences('Basket saved', next)} />
      </>
    );
    navigation.setOptions({ title: 'Enrollments' });
    announce('Household updated');`;
    expect(terms(source)).toEqual(['fixture', 'offering', 'basket', 'enrollment', 'household']);
    expect(
      customerTexts("export const D = [{ name: 'x', title: 'Discover' }];", 'src/navigation/d.ts'),
    ).toEqual(['Discover']);
  });

  it('PA-11: words are matched whole and in any case; inflected verbs are not the noun', () => {
    expect(bannedIn('ENROLMENTS').map((f) => f.term)).toEqual(['enrollment']);
    expect(bannedIn('We quoted a price; basketball later')).toEqual([]);
    expect(bannedIn('The household’s payment attempts').map((f) => f.term)).toEqual([
      'payment attempt',
      'household',
    ]);
  });

  it('PA-11: a long snippet is cut to 60 characters around the match', () => {
    const text = `${'a'.repeat(80)} basket ${'b'.repeat(80)}`;
    const snippet = snippetOf(text, text.indexOf('basket'));
    expect(snippet).toHaveLength(60);
    expect(snippet).toContain('basket');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('PA-11: tests, dev screens, web stores and the vocabulary itself are not guarded', () => {
    expect(isGuardedFile('src/screens/home/HomeScreen.tsx')).toBe(true);
    expect(isGuardedFile('app/(tabs)/index.tsx')).toBe(true);
    expect(isGuardedFile('src/screens/home/__tests__/home.test.tsx')).toBe(false);
    expect(isGuardedFile('src/features/package-g/testing.tsx')).toBe(false);
    expect(isGuardedFile('src/dev-gallery/GalleryScreen.tsx')).toBe(false);
    expect(isGuardedFile('src/demo/tour.ts')).toBe(false);
    expect(isGuardedFile('src/copy/pending.ts')).toBe(false);
    expect(isGuardedFile('src/ui/secure-theme-store.web.ts')).toBe(false);
  });

  it('PA-11: every banned term and kept phrase is well formed', () => {
    for (const banned of BANNED_CUSTOMER_TERMS) expect(banned.instead).not.toBe('');
    expect(new Set(KEPT_PHRASES).size).toBe(KEPT_PHRASES.length);
    for (const phrase of ['Try again', 'Check again', 'Do not pay again']) {
      expect(KEPT_PHRASES).toContain(phrase);
    }
  });
});

describe('PA-11 SPK-UX-011 copy guard: the ratchet', () => {
  const current = currentEntries(APP_ROOT);
  const exists = fs.existsSync(BASELINE);
  if (process.env.UPDATE_COPY_BASELINE) {
    const listed: string[] = exists ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : current;
    // Only shrinks: the listed entries that still occur. A new finding is not added.
    const next = beyond(listed, beyond(listed, current)).sort(compare);
    fs.writeFileSync(BASELINE, formatBaseline(next));
  }
  const baseline: string[] = fs.existsSync(BASELINE)
    ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    : [];

  it('PA-11: the baseline is sorted, so each file’s entries stay together', () => {
    expect([...baseline].sort(compare)).toEqual(baseline);
  });

  it('PA-11: no customer text uses an internal word or code that is not in the baseline', () => {
    const added = beyond(current, baseline);
    if (added.length > 0) {
      throw new Error(
        [
          `Customer text uses internal words or codes (PA-11, SPK-UX-011):`,
          ...added.map((entry) => `  ${entry}`),
          `Use the customer word from src/copy/vocabulary.ts (CUSTOMER_VOCABULARY), or move the`,
          `code into <SupportDetails>. Do not add these lines to customer-words.baseline.json.`,
        ].join('\n'),
      );
    }
  });

  it('PA-11: every baseline entry still occurs (the list only shrinks)', () => {
    const stale = beyond(baseline, current);
    if (stale.length > 0) {
      throw new Error(
        [
          `These entries no longer occur; delete them from src/copy/customer-words.baseline.json`,
          `(or run UPDATE_COPY_BASELINE=1 pnpm exec jest src/copy):`,
          ...stale.map((entry) => `  ${entry}`),
        ].join('\n'),
      );
    }
  });
});
