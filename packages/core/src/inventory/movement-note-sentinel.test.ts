import { describe, expect, it } from 'vitest';

import {
  RECEIPT_NOTE_SENTINEL_RE,
  isMovementNoteEditable,
  isReceiptNoteSentinel,
  userMovementNote,
} from './movement-note-sentinel';

/** A real receipt id from the prod ledger's shape (lowercase, hyphenated). */
const SENTINEL = 'b3c7390a-b114-4839-a100-a008d3f3fde0';

describe('isReceiptNoteSentinel', () => {
  it('masks a bare uuid — the sentinel post_receipt_v2 writes', () => {
    expect(isReceiptNoteSentinel(SENTINEL)).toBe(true);
  });

  it('masks a whitespace-padded uuid (the column is built by SQL concatenation)', () => {
    expect(isReceiptNoteSentinel(`  ${SENTINEL}  `)).toBe(true);
    expect(isReceiptNoteSentinel(`\n${SENTINEL}\t`)).toBe(true);
  });

  it('accepts uppercase hex — postgres uuid casts are lowercase, but the test is not case-bound', () => {
    expect(isReceiptNoteSentinel(SENTINEL.toUpperCase())).toBe(true);
  });

  it('does NOT mask a uuid embedded in a sentence — that is real user text', () => {
    // THE boundary that keeps this from deleting an operator's words. A person
    // who pasted an id into a note wrote prose around it; the sentinel never
    // has any.
    expect(isReceiptNoteSentinel(`swapped for ${SENTINEL} per Dana`)).toBe(false);
    expect(isReceiptNoteSentinel(`${SENTINEL} was the wrong receipt`)).toBe(false);
    expect(isReceiptNoteSentinel(`see ${SENTINEL}`)).toBe(false);
  });

  it('does NOT mask uuid-ish text that is not actually a uuid', () => {
    expect(isReceiptNoteSentinel('not-a-uuid')).toBe(false);
    expect(isReceiptNoteSentinel(SENTINEL.slice(0, -1))).toBe(false);
    expect(isReceiptNoteSentinel(`${SENTINEL}0`)).toBe(false);
    expect(isReceiptNoteSentinel('zzzzzzzz-b114-4839-a100-a008d3f3fde0')).toBe(false);
  });

  it('treats absent and empty notes as "nothing to hide", not as a sentinel', () => {
    expect(isReceiptNoteSentinel(null)).toBe(false);
    expect(isReceiptNoteSentinel(undefined)).toBe(false);
    expect(isReceiptNoteSentinel('')).toBe(false);
    expect(isReceiptNoteSentinel('   ')).toBe(false);
  });

  it('is stateless across repeated calls (no /g flag, no lastIndex drift)', () => {
    // A shared regex instance with /g would alternate true/false here. This
    // pins the property rather than trusting the flag list stays right.
    expect(RECEIPT_NOTE_SENTINEL_RE.flags).not.toContain('g');
    for (let i = 0; i < 5; i += 1) expect(isReceiptNoteSentinel(SENTINEL)).toBe(true);
  });
});

describe('userMovementNote', () => {
  it('masks the sentinel to null so it never renders as a quoted note', () => {
    expect(userMovementNote(SENTINEL)).toBeNull();
    expect(userMovementNote(`  ${SENTINEL}  `)).toBeNull();
  });

  it('returns real user text VERBATIM — masking, never formatting', () => {
    expect(userMovementNote('Handled with care')).toBe('Handled with care');
    // Untrimmed on purpose: this function does not rewrite what a person typed.
    expect(userMovementNote('  spaced out  ')).toBe('  spaced out  ');
    expect(userMovementNote(`swapped for ${SENTINEL} per Dana`)).toBe(
      `swapped for ${SENTINEL} per Dana`,
    );
  });

  it('passes null/undefined/empty through unchanged', () => {
    expect(userMovementNote(null)).toBeNull();
    expect(userMovementNote(undefined)).toBeNull();
    expect(userMovementNote('')).toBe('');
  });
});

describe('isMovementNoteEditable', () => {
  it('refuses the post-0231 leak: reason is PO {number}, notes still the sentinel', () => {
    // The 80 prod rows this whole change exists for. The old reason-only test
    // called these editable, and saving would have destroyed the receipt link.
    expect(isMovementNoteEditable('PO CVW-002201', SENTINEL)).toBe(false);
    expect(isMovementNoteEditable('receipt_reversal', SENTINEL)).toBe(false);
  });

  it("refuses a pre-0231 'receipt_line' row, agreeing with the RPC's 22023 guard", () => {
    expect(isMovementNoteEditable('receipt_line', SENTINEL)).toBe(false);
    // Even with no sentinel left, the RPC would still reject this reason, so
    // the UI must not offer an affordance whose only outcome is an error.
    expect(isMovementNoteEditable('receipt_line', null)).toBe(false);
    expect(isMovementNoteEditable('receipt_line', 'someone typed this')).toBe(false);
  });

  it('allows every ordinary row, including a PO row with a genuine note', () => {
    expect(isMovementNoteEditable('PO CVW-002201', 'Pallet arrived damp')).toBe(true);
    expect(isMovementNoteEditable('Damaged in transit', null)).toBe(true);
    expect(isMovementNoteEditable(null, null)).toBe(true);
    expect(isMovementNoteEditable(null, 'Free-text note')).toBe(true);
    expect(isMovementNoteEditable(undefined, undefined)).toBe(true);
  });

  it('allows a note that merely MENTIONS a uuid', () => {
    expect(isMovementNoteEditable('Correction', `see ${SENTINEL}`)).toBe(true);
  });
});
