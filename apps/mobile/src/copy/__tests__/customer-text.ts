/**
 * The copy guard's extractor (PA-11, SPK-UX-011 **Proposed**): reads a source file with the
 * TypeScript compiler and returns the text customers can see or hear, then the banned terms
 * (`src/copy/vocabulary.ts`) in it. Used by `customer-words.test.ts`; not part of the app.
 *
 * Customer text is:
 * - JSX text, and string or template literals written as a JSX child (`{ok ? 'Done' : 'Failed'}`);
 * - string and template literals given to a display prop (`VISIBLE_PROPS`, `VISIBLE_JSX_PROPS`,
 *   or any prop whose name ends in `Label` or `Title`), directly, in an array, through a
 *   conditional or `??`/`||`/`&&`/`+`, or through `sentences(…)`;
 * - the same literals as the value of a display-named property (`VISIBLE_PROPS`, `…Label`,
 *   `…Title`) of any object literal: `Stack.Screen options={{ title }}`, `setOptions({ title })`,
 *   the tab destinations, `empty={{ title, description }}`, `action={{ label }}` and the label
 *   maps of the feature models (`{ label: 'In your basket…' }`);
 * - everything passed to an announcement (`announcement=`, `announce(…)`, `useAnnouncement(…)`).
 *
 * Not customer text: anything inside a `<SupportDetails …>` element, including its props;
 * `testID`, `href`, `key`, `name` and other props not listed; call arguments other than the above
 * (route strings, query keys, formatter options); object keys; comments. Text held in a constant
 * or returned by a function and rendered elsewhere is not traced (known gap).
 *
 * A template literal reads as its text with "…" for each expression, so
 * `Pay ${formatMoney(x)}` is "Pay …", and the expressions are read as customer text in turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { BANNED_CUSTOMER_TERMS, KEPT_PHRASE_PATTERNS } from '../vocabulary';

/** Display props whose literal values customers see. */
export const VISIBLE_PROPS: ReadonlySet<string> = new Set([
  'label',
  'title',
  'message',
  'subtitle',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'hint',
  'summaryLabel',
  'eyebrow',
  'description',
  'emptyTitle',
  'emptyMessage',
  // Also shown as written: row details and explanations.
  'detail',
  'explanation',
]);

/**
 * JSX props of the app's own components that render their text as well (`Field value`, the
 * pending state's `subject`, the sign-in prompt's `what`, the offline list `unavailableOffline`).
 * Not read as object keys: `{ value: 'week', label: 'Week' }` is an option whose value is a key.
 */
export const VISIBLE_JSX_PROPS: ReadonlySet<string> = new Set([
  'value',
  'subject',
  'what',
  'stillAvailable',
  'purpose',
  'unavailableOffline',
]);

/** Calls whose arguments are spoken to the customer. */
const ANNOUNCE_CALLS: ReadonlySet<string> = new Set([
  'announce',
  'useAnnouncement',
  'announceForAccessibility',
  'announceForAccessibilityWithOptions',
]);

/** Helpers that join their string arguments into the visible sentence. */
const JOINING_CALLS: ReadonlySet<string> = new Set(['sentences']);

/** The longest snippet recorded for a finding. */
export const SNIPPET_LENGTH = 60;

/** Whether an object key or JSX prop of this name holds customer text. */
export function isVisibleProp(name: string): boolean {
  return VISIBLE_PROPS.has(name) || /(Label|Title)$/.test(name);
}

/** Whether a JSX prop of this name holds customer text. */
export function isVisibleAttribute(name: string): boolean {
  return isVisibleProp(name) || VISIBLE_JSX_PROPS.has(name);
}

const ENTITIES: Record<string, string> = {
  '&apos;': "'",
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

function normalize(text: string): string {
  return text
    .replace(/&(?:apos|quot|amp|lt|gt|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return undefined;
}

function tagName(node: ts.JsxTagNameExpression): string {
  return ts.isIdentifier(node) ? node.text : node.getText();
}

function isSupportDetails(node: ts.Node): boolean {
  const tag = ts.isJsxElement(node)
    ? node.openingElement.tagName
    : ts.isJsxSelfClosingElement(node)
      ? node.tagName
      : null;
  return tag !== null && /(^|\.)SupportDetails$/.test(tagName(tag));
}

/** The customer text of one source file, in source order. */
export function customerTexts(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Map<number, string>();
  const add = (node: ts.Node, text: string) => {
    const value = normalize(text);
    if (value !== '') found.set(node.getStart(file), value);
  };

  /** Literals an expression evaluates to; `deep` follows every call's arguments too. */
  const literals = (expr: ts.Expression | undefined, deep = false): void => {
    if (!expr) return;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      add(expr, expr.text);
    } else if (ts.isTemplateExpression(expr)) {
      add(expr, expr.head.text + expr.templateSpans.map((s) => `…${s.literal.text}`).join(''));
      for (const span of expr.templateSpans) literals(span.expression, deep);
    } else if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      literals(expr.expression, deep);
    } else if (ts.isConditionalExpression(expr)) {
      literals(expr.whenTrue, deep);
      literals(expr.whenFalse, deep);
    } else if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        literals(expr.left, deep);
        literals(expr.right, deep);
      }
    } else if (ts.isCallExpression(expr)) {
      const callee = nameOf(expr.expression);
      if (deep || (callee && JOINING_CALLS.has(callee))) {
        for (const arg of expr.arguments) literals(arg, deep);
      }
    } else if (ts.isArrayLiteralExpression(expr)) {
      for (const element of expr.elements) literals(element, deep);
    }
  };

  const visit = (node: ts.Node): void => {
    if (isSupportDetails(node)) return;
    if (ts.isJsxText(node)) {
      if (!node.containsOnlyTriviaWhiteSpaces) add(node, node.text);
    } else if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      literals(node.expression);
    } else if (ts.isJsxAttribute(node)) {
      const name = nameOf(node.name) ?? node.name.getText(file);
      const init = node.initializer;
      if (init && ts.isStringLiteral(init)) {
        if (isVisibleAttribute(name) || name === 'announcement') add(init, init.text);
      } else if (init && ts.isJsxExpression(init)) {
        if (name === 'announcement') literals(init.expression, true);
        else if (isVisibleAttribute(name)) literals(init.expression);
      }
    } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      // `options={{ title }}`, `empty={{ title, description }}`, `setOptions({ title })`, the tab
      // destinations and the label maps of the feature models.
      const name = nameOf(node.name);
      if (name && isVisibleProp(name)) literals(node.initializer);
    } else if (ts.isCallExpression(node)) {
      const callee = nameOf(node.expression);
      if (callee && ANNOUNCE_CALLS.has(callee)) {
        for (const arg of node.arguments) literals(arg, true);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);
}

/** A banned term in a piece of customer text. */
export interface Finding {
  term: string;
  snippet: string;
}

/** The text around a match, at most `SNIPPET_LENGTH` characters, "…" where it was cut. */
export function snippetOf(text: string, index: number): string {
  if (text.length <= SNIPPET_LENGTH) return text;
  const start = Math.max(0, Math.min(index - 20, text.length - SNIPPET_LENGTH));
  let out = text.slice(start, start + SNIPPET_LENGTH);
  if (start > 0) out = `…${out.slice(1)}`;
  if (start + SNIPPET_LENGTH < text.length) out = `${out.slice(0, -1)}…`;
  return out;
}

/** The banned terms in one piece of customer text, once per term, kept phrases removed first. */
export function bannedIn(
  text: string,
  keptPhrases: readonly RegExp[] = KEPT_PHRASE_PATTERNS,
): Finding[] {
  let checked = text;
  for (const kept of keptPhrases) {
    checked = checked.replace(kept, (phrase) => ' '.repeat(phrase.length));
  }
  const findings: Finding[] = [];
  for (const banned of BANNED_CUSTOMER_TERMS) {
    const match = banned.pattern.exec(checked);
    if (match) findings.push({ term: banned.term, snippet: snippetOf(text, match.index) });
  }
  return findings;
}

/** The banned terms in a source file's customer text. */
export function scanSource(source: string, fileName: string): Finding[] {
  return customerTexts(source, fileName).flatMap((text) => bannedIn(text));
}

/** One ratchet entry: `relativePath :: term :: snippet`. */
export function entryOf(relativePath: string, finding: Finding): string {
  return `${relativePath} :: ${finding.term} :: ${finding.snippet}`;
}

/** Whether a file under the app root is customer source the guard reads. */
export function isGuardedFile(relativePath: string): boolean {
  const p = relativePath.split(path.sep).join('/');
  if (!/\.tsx?$/.test(p) || p.endsWith('.d.ts')) return false;
  if (/\.web\.tsx?$/.test(p)) return false;
  if (/(^|\/)__tests__\//.test(p) || /\.(test|spec)\.tsx?$/.test(p)) return false;
  if (/(^|\/)testing(\.tsx?|\/)/.test(p)) return false;
  return !/^src\/(dev|demo|dev-gallery|copy)\//.test(p);
}

/** The guarded files under `appRoot/src` and `appRoot/app`, relative and sorted. */
export function guardedFiles(appRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(appRoot, full).split(path.sep).join('/');
        if (isGuardedFile(relative)) out.push(relative);
      }
    }
  };
  walk(path.join(appRoot, 'src'));
  walk(path.join(appRoot, 'app'));
  return out.sort();
}

/** Every ratchet entry of the app today, sorted (repeated entries kept). */
export function currentEntries(appRoot: string): string[] {
  return guardedFiles(appRoot)
    .flatMap((relative) =>
      scanSource(fs.readFileSync(path.join(appRoot, relative), 'utf8'), relative).map((f) =>
        entryOf(relative, f),
      ),
    )
    .sort(compare);
}

/** Code-unit order, the same on every machine. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The baseline file's text: a sorted JSON array, a blank line between files. */
export function formatBaseline(entries: readonly string[]): string {
  if (entries.length === 0) return '[]\n';
  const lines: string[] = [];
  let previous: string | null = null;
  entries.forEach((entry, i) => {
    const file = entry.slice(0, entry.indexOf(' :: '));
    if (previous !== null && file !== previous) lines.push('');
    previous = file;
    lines.push(`  ${JSON.stringify(entry)}${i < entries.length - 1 ? ',' : ''}`);
  });
  return `[\n${lines.join('\n')}\n]\n`;
}

/** What `actual` has beyond `allowed`, counting repeats. */
export function beyond(actual: readonly string[], allowed: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const entry of allowed) left.set(entry, (left.get(entry) ?? 0) + 1);
  const extra: string[] = [];
  for (const entry of actual) {
    const n = left.get(entry) ?? 0;
    if (n > 0) left.set(entry, n - 1);
    else extra.push(entry);
  }
  return extra;
}
