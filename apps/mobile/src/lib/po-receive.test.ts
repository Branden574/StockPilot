import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OVER_RECEIPT_CONFIRM_LABEL,
  OVER_RECEIPT_CONFIRM_TITLE,
  overReceiptConfirmMessage,
  overReceiptUnits,
  RECEIPT_NOTES_LABEL,
  receiptNotesForPost,
} from './po-receive';

/**
 * Receiving on the phone.
 *   L21: the phone refused a receipt over what was ordered ("Too many"),
 *        although the server allows it (0285) and the web asks instead; and
 *        it sent no notes. It now asks "Receive anyway?" and sends an optional
 *        note, which the route already accepts.
 *   L77: a draft PO (read-only here) still said "you don't need to post a
 *        receipt to keep an attachment"; the hint now shows only on a PO that
 *        can be received.
 */

const LINES = [
  { id: 'a', quantity_ordered: 10, quantity_received: 4 },
  { id: 'b', quantity_ordered: 5, quantity_received: 5 },
  { id: 'c', quantity_ordered: 3, quantity_received: 0 },
];

describe('overReceiptUnits', () => {
  it('sums, over the lines, what is entered past what is left to receive', () => {
    expect(overReceiptUnits(LINES, { a: { received: '8' }, b: { received: '2' }, c: { received: '3' } })).toBe(4);
  });
  it('nothing over, or nothing entered: 0', () => {
    expect(overReceiptUnits(LINES, { a: { received: '6' }, c: { received: '' } })).toBe(0);
    expect(overReceiptUnits(LINES, {})).toBe(0);
  });
});

describe('the over-receipt confirm', () => {
  it('says how many more than ordered and asks', () => {
    expect(OVER_RECEIPT_CONFIRM_TITLE).toBe('Receive more than ordered?');
    expect(overReceiptConfirmMessage(4)).toBe("You're receiving 4 more than ordered. Receive anyway?");
    expect(OVER_RECEIPT_CONFIRM_LABEL).toBe('Receive anyway');
  });
});

describe('receiptNotesForPost', () => {
  it('a typed note is sent trimmed; an empty one is not sent', () => {
    expect(RECEIPT_NOTES_LABEL).toBe('Notes (optional)');
    expect(receiptNotesForPost('  Box 2 was crushed  ')).toBe('Box 2 was crushed');
    expect(receiptNotesForPost('   ')).toBeUndefined();
  });
  it('never longer than the route accepts (2000)', () => {
    expect(receiptNotesForPost('x'.repeat(2500))).toHaveLength(2000);
  });
});

describe('po/[id].tsx wiring', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/po/[id].tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // Mutation caught: the refusal back, or the confirm skipped.
  it('asks before an over-receipt instead of refusing it (L21)', () => {
    expect(screen).not.toContain("'Too many'");
    expect(screen).toContain('const over = overReceiptUnits(lines, draft);');
    expect(screen).toMatch(
      /Alert\.alert\(\s*OVER_RECEIPT_CONFIRM_TITLE,\s*overReceiptConfirmMessage\(over\),\s*\[/,
    );
    expect(screen).toMatch(/text: OVER_RECEIPT_CONFIRM_LABEL,[\s\S]{0,80}onPress: \(\) => void sendReceipt\(\)/);
  });

  // Mutation caught: the double-tap guard left only in sendReceipt, after the
  // alert. Two quick taps then queued two confirms; the first post retired the
  // key, so confirming the second minted a new one and posted the
  // over-receipt again (a duplicate receipt, double-counted stock).
  it('a second tap while the over-receipt confirm is up does not queue another (desk check F2)', () => {
    const post = screen.slice(
      screen.indexOf('async function postReceipt()'),
      screen.indexOf('async function sendReceipt()'),
    );
    const guard = post.indexOf('if (confirmingRef.current || submittingRef.current) return;');
    const set = post.indexOf('confirmingRef.current = true;');
    const alert = post.search(/Alert\.alert\(\s*OVER_RECEIPT_CONFIRM_TITLE/);
    expect(guard).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(guard);
    expect(alert).toBeGreaterThan(set);
    // Cancel (and an Android dismiss) lets the next tap ask again.
    expect(post).toMatch(
      /\{\s*text: 'Cancel',\s*style: 'cancel',\s*onPress: \(\) => \{\s*confirmingRef\.current = false;\s*\},?\s*\}/,
    );
    expect(post).toMatch(/onDismiss: \(\) => \{\s*confirmingRef\.current = false;\s*\}/);
    // Confirming hands over to sendReceipt's own guard, which clears it first.
    expect(screen).toMatch(/async function sendReceipt\(\) \{\s*confirmingRef\.current = false;/);
  });

  // Mutation caught: the note typed but never sent.
  it('sends the optional note with the receipt (L21)', () => {
    expect(screen).toContain('notes: receiptNotesForPost(notes),');
    expect(screen).toContain('{RECEIPT_NOTES_LABEL}');
  });

  // Mutation caught: the hint shown on a draft again.
  it('the attachment hint shows only on a PO that can be received (L77)', () => {
    expect(screen).toMatch(/\{reviewOnly \? null : \(\s*<Text style=\{styles\.attachHint\}>/);
  });
});
