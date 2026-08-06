import { describe, expect, it } from 'vitest';

import { maintenanceRequestFormSchema } from './maintenance';

/**
 * Minimal valid payload — every optional field omitted. `priority` is
 * intentionally absent to exercise the schema default.
 */
const VALID = {
  subject: 'Air conditioner is not working',
  description: 'The unit has been blowing warm air since yesterday afternoon.',
};

const UUID_A = '11111111-1111-1111-1111-111111111111';

// Built via String.fromCharCode rather than typed \uXXXX escapes, matching
// the convention in maintenance/text.test.ts, so this source file's literal
// bytes stay plain ASCII.
const BEL = String.fromCharCode(7);
const NUL = String.fromCharCode(0);

describe('maintenanceRequestFormSchema — happy path', () => {
  it('accepts the minimal valid payload and defaults priority to normal', () => {
    const parsed = maintenanceRequestFormSchema.safeParse(VALID);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.priority).toBe('normal');
      expect(parsed.data.subject).toBe(VALID.subject);
      expect(parsed.data.description).toBe(VALID.description);
    }
  });

  it('accepts every optional field populated with valid values', () => {
    const full = {
      ...VALID,
      category: 'Electrical',
      priority: 'urgent' as const,
      charterId: UUID_A,
      warehouseId: UUID_A,
      building: 'Main Building',
      roomOrArea: 'Room 204',
      department: 'Operations',
      accessInstructions: 'Contact the front office before entering.',
      requesterPhone: '(555) 555-0199',
      relatedItemId: UUID_A,
      relatedOrderRequestId: UUID_A,
      relatedRentalId: UUID_A,
      relatedLocationId: UUID_A,
    };
    const parsed = maintenanceRequestFormSchema.safeParse(full);
    expect(parsed.success).toBe(true);
  });

  it('accepts explicit null for every nullish field (clears rather than omits)', () => {
    const parsed = maintenanceRequestFormSchema.safeParse({
      ...VALID,
      category: null,
      charterId: null,
      warehouseId: null,
      building: null,
      roomOrArea: null,
      department: null,
      accessInstructions: null,
      requesterPhone: null,
      relatedItemId: null,
      relatedOrderRequestId: null,
      relatedRentalId: null,
      relatedLocationId: null,
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * BINDING CONSTRAINT: no recipient field exists anywhere in this schema.
 * Recipients are server constants (L4L_MAINTENANCE_EMAIL) — a client can
 * never supply them. `.strict()` at the (only) object depth means any
 * unrecognized key, including a recipient-shaped one, is a hard rejection,
 * not silent stripping.
 */
describe('maintenanceRequestFormSchema — NO recipient override surface', () => {
  it.each([
    'to',
    'cc',
    'bcc',
    'recipient',
    'recipients',
    'recipientOverride',
    'toEmail',
    'ccEmail',
  ])('rejects a payload carrying a %s key (strict unknown-key rejection)', (key) => {
    const parsed = maintenanceRequestFormSchema.safeParse({
      ...VALID,
      [key]: 'attacker@evil.test',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects ANY unrecognized key, not just recipient-shaped ones (proves .strict(), not a denylist)', () => {
    const parsed = maintenanceRequestFormSchema.safeParse({
      ...VALID,
      somethingUnrelated: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('the schema shape itself has no recipient-named key at all', () => {
    const shape = maintenanceRequestFormSchema.shape as Record<string, unknown>;
    for (const forbidden of ['to', 'cc', 'bcc', 'recipient', 'recipients']) {
      expect(Object.prototype.hasOwnProperty.call(shape, forbidden)).toBe(false);
    }
  });
});

describe('maintenanceRequestFormSchema — subject (Brief §7)', () => {
  it('rejects a missing subject', () => {
    const { subject, ...rest } = VALID;
    void subject;
    expect(maintenanceRequestFormSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a subject shorter than 5 meaningful characters', () => {
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, subject: 'AC' }).success).toBe(false);
  });

  it('accepts a subject at exactly the 120-character cap and rejects one character over', () => {
    const atCap = 'A'.repeat(120);
    const overCap = 'A'.repeat(121);
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, subject: atCap }).success).toBe(true);
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, subject: overCap }).success).toBe(
      false,
    );
  });

  it('rejects a punctuation-only subject', () => {
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, subject: '!!!??? --- ...' }).success,
    ).toBe(false);
  });

  it('preserves normal punctuation in an otherwise meaningful subject', () => {
    const parsed = maintenanceRequestFormSchema.safeParse({
      ...VALID,
      subject: "AC's broken, again! (Room 204)",
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a subject containing a line break', () => {
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, subject: 'AC broken\nin Room 204' })
        .success,
    ).toBe(false);
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, subject: 'AC broken\r\nin Room 204' })
        .success,
    ).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    const parsed = maintenanceRequestFormSchema.safeParse({
      ...VALID,
      subject: '  AC broken in Room 204  ',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.subject).toBe('AC broken in Room 204');
  });
});

describe('maintenanceRequestFormSchema — description (Brief §7)', () => {
  it('rejects a missing description', () => {
    const { description, ...rest } = VALID;
    void description;
    expect(maintenanceRequestFormSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a description shorter than the 10-character minimum', () => {
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, description: 'too short' }).success,
    ).toBe(false);
  });

  it('accepts a description at exactly the 5000-character cap and rejects one character over', () => {
    const atCap = 'x'.repeat(5000);
    const overCap = 'x'.repeat(5001);
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, description: atCap }).success).toBe(
      true,
    );
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, description: overCap }).success).toBe(
      false,
    );
  });

  it('preserves intentional line breaks (does not require the collapsing sanitizer)', () => {
    const withBreaks = 'Line one describing the issue.\nLine two with more detail.';
    const parsed = maintenanceRequestFormSchema.safeParse({
      ...VALID,
      description: withBreaks,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.description).toBe(withBreaks);
  });
});

/**
 * Fix wave 1 (owner §7 gap): sanitization now happens HERE, at the shared
 * schema, not just at email-build time — this is the whole point of the
 * fix. Every case below documents the ORDERING decision recorded in the
 * schema's doc comment (sanitize-then-check) and its consequences.
 */
describe('maintenanceRequestFormSchema — sanitization at intake (Fix wave 1, owner §7 gap)', () => {
  it('subject: a stray control character is stripped, not merely accepted verbatim', () => {
    // MUTATION TARGET: dropping `.transform(sanitizeSubjectLine)` from the
    // subject pipeline leaves this passing on `.success` (BEL is not
    // whitespace, so the meaningful-content refine still sees 3+
    // consecutive letters either side) but the OUTPUT would still contain
    // the raw BEL byte — the assertions on `parsed.data.subject` below are
    // what actually catches that mutation.
    const raw = `Air${BEL} conditioner is broken`;
    const parsed = maintenanceRequestFormSchema.safeParse({ ...VALID, subject: raw });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subject).toBe('Air conditioner is broken');
      expect(parsed.data.subject).not.toContain(BEL);
    }
  });

  it('subject: control characters interspersed among 5 real letters still pass (ordering proof — see schema doc comment)', () => {
    // Constructed so a naive check-BEFORE-sanitize implementation would
    // reject this: the meaningful-content refine strips \s before testing
    // for 3+ consecutive letter/digit characters, but BEL/NUL are not \s,
    // so on the RAW value "A", "B", "C", "D", "E" are never consecutive.
    // Sanitizing first turns each control byte into a space (which the
    // refine's own \s-strip then removes), so the 5 real letters are
    // correctly recognized as meaningful content.
    const raw = `${NUL}A${BEL}B${NUL}C${BEL}D${NUL}E${BEL}`;
    const parsed = maintenanceRequestFormSchema.safeParse({ ...VALID, subject: raw });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.subject).toBe('A B C D E');
  });

  it('subject: an embedded line break is still REJECTED, exactly as before this fix (sanitizing does not turn this into a silent strip)', () => {
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, subject: 'AC broken\nin Room 204' })
        .success,
    ).toBe(false);
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, subject: 'AC broken\r\nin Room 204' })
        .success,
    ).toBe(false);
  });

  it('description: CRLF is preserved as a single \\n (schema-level sanitization does not change the existing newline normalization)', () => {
    const raw = 'Line one describing the issue.\r\nLine two with more detail.';
    const parsed = maintenanceRequestFormSchema.safeParse({ ...VALID, description: raw });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe(
        'Line one describing the issue.\nLine two with more detail.',
      );
    }
  });

  it('description: BEL/NUL are stripped while intentional newlines survive intact (MUTATION: swapping in sanitizeSubjectLine here must fail this test)', () => {
    const raw = `Line one${BEL} describing the issue.\nLine two${NUL} with more detail.`;
    const parsed = maintenanceRequestFormSchema.safeParse({ ...VALID, description: raw });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe(
        'Line one describing the issue.\nLine two with more detail.',
      );
      expect(parsed.data.description).toContain('\n');
      expect(parsed.data.description).not.toContain(BEL);
      expect(parsed.data.description).not.toContain(NUL);
    }
  });

  it('description: a 5,001-character raw value whose control byte sanitizes away lands at exactly the 5,000 cap and is accepted (sanitize-then-length-check — the documented ordering choice)', () => {
    const raw = `${'x'.repeat(4999)}${NUL}x`; // 5,001 raw chars; the lone NUL is deleted by sanitizeDescriptionBlock
    expect(raw.length).toBe(5001);
    const parsed = maintenanceRequestFormSchema.safeParse({ ...VALID, description: raw });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description).toBe('x'.repeat(5000));
      expect(parsed.data.description.length).toBe(5000);
    }
  });
});

describe('maintenanceRequestFormSchema — priority enum (Brief §7)', () => {
  it('accepts every MAINTENANCE_PRIORITIES member', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as const) {
      expect(maintenanceRequestFormSchema.safeParse({ ...VALID, priority: p }).success).toBe(true);
    }
  });

  it('rejects a value outside the enum', () => {
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, priority: 'critical' }).success).toBe(
      false,
    );
  });

  it('defaults to normal when omitted', () => {
    const parsed = maintenanceRequestFormSchema.safeParse(VALID);
    expect(parsed.success && parsed.data.priority).toBe('normal');
  });
});

describe('maintenanceRequestFormSchema — field caps (Brief §7 / migration 0314 CHECKs)', () => {
  const cases: Array<[string, number]> = [
    ['category', 80],
    ['building', 200],
    ['roomOrArea', 200],
    ['department', 200],
    ['accessInstructions', 2000],
    ['requesterPhone', 40],
  ];

  it.each(cases)('%s accepts exactly its cap and rejects one character over', (field, cap) => {
    const atCap = 'x'.repeat(cap);
    const overCap = 'x'.repeat(cap + 1);
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, [field]: atCap }).success).toBe(true);
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, [field]: overCap }).success).toBe(
      false,
    );
  });
});

describe('maintenanceRequestFormSchema — related-record and site UUID fields', () => {
  const uuidFields = [
    'charterId',
    'warehouseId',
    'relatedItemId',
    'relatedOrderRequestId',
    'relatedRentalId',
    'relatedLocationId',
  ];

  it.each(uuidFields)('%s rejects a non-UUID string', (field) => {
    expect(
      maintenanceRequestFormSchema.safeParse({ ...VALID, [field]: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it.each(uuidFields)('%s accepts a well-formed UUID', (field) => {
    expect(maintenanceRequestFormSchema.safeParse({ ...VALID, [field]: UUID_A }).success).toBe(
      true,
    );
  });
});
