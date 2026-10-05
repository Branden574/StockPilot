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
  varianceCaption,
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

// Review (2026-10-05): now that the phone takes an over-receipt, its line
// card showed a bare "VARIANCE -2" beside an alert saying "2 more than
// ordered", and -2 reads as two short. The web receive dialog
// (po-receive-dialog.tsx) captions the same number and colours an over
// receipt red; the phone now says it in the web's words.
describe('varianceCaption (the web receive dialog\'s words)', () => {
  it('what is still to come, fully received, or how many over ordered', () => {
    expect(varianceCaption(3)).toBe('3 still to come');
    expect(varianceCaption(0)).toBe('Fully received');
    expect(varianceCaption(-2)).toBe('2 over ordered');
  });
  it('matches the web dialog, word for word', () => {
    const web = readFileSync(
      path.resolve(__dirname, '../../../web/src/components/po/po-receive-dialog.tsx'),
      'utf8',
    );
    expect(web).toContain('`${variance} still to come`');
    expect(web).toContain('`${Math.abs(variance)} over ordered`');
    expect(web).toContain("'Fully received'");
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

  // Mutation caught: the hint shown on a draft again. Review (2026-10-05):
  // and on a PO with nothing left to receive, where no receipt can be posted.
  it('the attachment hint shows only on a PO that can be received (L77)', () => {
    expect(screen).toMatch(/\{receivable \? \(\s*<Text style=\{styles\.attachHint\}>/);
  });

  // Review (2026-10-05): the Notes field showed on a fully received PO, whose
  // footer says Fully received and can post nothing, so the note could never
  // be sent. It shows only when a line has something left to receive, the
  // same rule as the footer's Post receipt.
  it('the Notes field shows only when a receipt can be posted, by the footer\'s own rule', () => {
    // Re-pinned by the small fixes slice 2 review (was !reviewOnly): a
    // reader without stock:adjust cannot post a receipt either (readOnly).
    expect(screen).toMatch(
      /const receivable =\s*!readOnly && lines\.some\(\(l\) => l\.quantity_ordered - l\.quantity_received > 0\);/,
    );
    expect(screen).toMatch(/\{receivable \? \(\s*<View style=\{styles\.notesBlock\}>/);
    expect(screen).toMatch(/disabled=\{posting \|\| !receivable\}/);
    expect(screen).not.toContain('const anyReceivable');
  });

  // Review (2026-10-05): the bare Variance number gets the web's caption on a
  // line with something left to receive, and an over receipt is red.
  it('the Variance metric says what its number means, red when over ordered', () => {
    expect(screen).toMatch(
      /<Metric\s+label="Variance"\s+value=\{variance\}\s+tone=\{variance < 0 \? 'danger' : 'primary'\}\s+caption=\{remaining > 0 \? varianceCaption\(variance\) : undefined\}\s*\/>/,
    );
    expect(screen).toMatch(/tone === 'danger' && \{ color: theme\.destructive \}/);
  });
});
