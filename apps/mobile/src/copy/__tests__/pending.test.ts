/**
 * PA-11, SPK-UX-011 (**Proposed**): a screen that waits on an operator decision says what the
 * customer can do instead. `src/copy/pending.ts` holds one plain message per decision a customer
 * can meet; this test keeps it complete and in customer words.
 */
import { CAPABILITY_PRESENTATION, isCapabilityId } from '@sportspark/api-client';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { PENDING_DECISION_FALLBACK } from '../../ui/StateView';
import { PENDING_FALLBACK, PENDING_MESSAGES, pendingMessage, pendingMessageFor } from '../pending';
import { bannedIn, guardedFiles } from './customer-text';

const APP_ROOT = path.resolve(__dirname, '../../..');

/**
 * Every DEC-### and POL-### in a string literal of customer source, and the decisions of the
 * capabilities it names (their turned-off states).
 */
function decisionsCustomersMeet(): string[] {
  const found = new Set<string>();
  for (const relative of guardedFiles(APP_ROOT)) {
    const source = fs.readFileSync(path.join(APP_ROOT, relative), 'utf8');
    const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node)) {
        for (const match of node.text.matchAll(/\b(?:DEC|POL)-\d{3}\b/g)) found.add(match[0]);
        if (isCapabilityId(node.text)) {
          for (const d of CAPABILITY_PRESENTATION[node.text].decisions) found.add(d);
        }
      } else if (ts.isTemplateExpression(node)) {
        const text = node.getText(file);
        for (const match of text.matchAll(/\b(?:DEC|POL)-\d{3}\b/g)) found.add(match[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...found].sort();
}

describe('PA-11 SPK-UX-011 pending messages', () => {
  it('PA-11: a known decision gives its plain instruction', () => {
    expect(pendingMessage('DEC-019')).toBe('Pay at the front desk for now.');
    expect(pendingMessage('DEC-004')).toBe('Ask the front desk to make this change for you.');
  });

  it('PA-11: an unknown decision gives the generic fallback, the same words as StateView', () => {
    expect(pendingMessage('DEC-999')).toBe("This isn't available in the app yet.");
    expect(PENDING_FALLBACK).toBe(PENDING_DECISION_FALLBACK);
  });

  it('PA-11: several decisions give the first specific one, after DEC-016', () => {
    expect(pendingMessageFor(['DEC-016', 'DEC-072'])).toBe('Ask the front desk about memberships.');
    expect(pendingMessageFor(['DEC-016'])).toBe(PENDING_MESSAGES['DEC-016']);
    expect(pendingMessageFor(['DEC-999'])).toBe(PENDING_FALLBACK);
  });

  it('PA-11: every decision a customer screen names has a message of its own', () => {
    const missing = decisionsCustomersMeet().filter((d) => PENDING_MESSAGES[d] === undefined);
    expect(missing).toEqual([]);
  });

  it('PA-11: every message is one plain instruction in customer words, without codes', () => {
    for (const [decision, message] of Object.entries(PENDING_MESSAGES)) {
      expect({ decision, findings: bannedIn(message) }).toEqual({ decision, findings: [] });
      expect(message).toMatch(/^[A-Z].*\.$/);
      expect(message).not.toMatch(/decid|decision|pending/i);
    }
  });
});
