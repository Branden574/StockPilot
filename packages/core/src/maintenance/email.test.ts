import { describe, expect, it } from 'vitest';

import {
  buildMaintenanceEmailDraft,
  prepareMaintenanceEmail,
  MAINTENANCE_CONDENSED_DISCLOSURE,
  type MaintenanceEmailInput,
} from './email';
import { OUTLOOK_COMPOSE_BASE, DRAFT_URL_LIMIT } from '../email/outlook-compose';

function decodeCompose(url: string): { to: string; params: Record<string, string> } {
  const outer = url.slice(url.indexOf('?') + 1);
  const mailtouri = outer
    .split('&')
    .map((p) => p.split('='))
    .find(([k]) => k === 'mailtouri')?.[1];
  if (!mailtouri) throw new Error('no mailtouri');
  const inner = decodeURIComponent(mailtouri);
  const q = inner.indexOf('?');
  const to = decodeURIComponent(inner.slice('mailto:'.length, q === -1 ? undefined : q));
  const params: Record<string, string> = {};
  if (q !== -1)
    for (const pair of inner.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    }
  return { to, params };
}

const FULL_INPUT: MaintenanceEmailInput = {
  requestNumber: 'MR-2026-000123',
  subject: 'Air conditioner is not working in Room 204',
  description:
    'The air conditioner has been blowing warm air since yesterday afternoon.\nThe room is becoming too warm for normal use.',
  category: 'Heating or air conditioning',
  priority: 'high',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: 'jane.smith@learn4life.org',
  requesterPhone: '(555) 555-0199',
  siteName: 'Fresno Learning Center',
  department: 'Operations',
  building: 'Main Building',
  roomOrArea: 'Room 204',
  accessInstructions: 'Please contact the main office before entering the room.',
  relatedItem: {
    name: 'Wall-mounted HVAC unit',
    sku: 'HVAC-WALL-204',
    barcode: '012345678905',
    modelNumber: 'ACX-9000',
    warehouseName: 'Fresno Distribution Center',
    locationName: 'Room 204 Closet',
    url: 'https://stockpilotusa.com/dashboard/inventory/11111111-1111-1111-1111-111111111111',
  },
  relatedOrder: null,
  relatedRental: null,
  photoCount: 3,
  shareUrl: 'https://stockpilotusa.com/m/abcdef1234567890',
};

const MINIMAL_INPUT: MaintenanceEmailInput = {
  requestNumber: 'MR-2026-000007',
  subject: 'Door hinge squeaks badly',
  description: 'The front door hinge squeaks loudly.',
  category: null,
  priority: 'normal',
  submittedAtDisplay: 'August 5, 2026 at 9:15 AM',
  requesterName: 'Jane Smith',
  requesterEmail: null,
  requesterPhone: null,
  siteName: null,
  department: null,
  building: null,
  roomOrArea: null,
  accessInstructions: null,
  relatedItem: null,
  relatedOrder: null,
  relatedRental: null,
  photoCount: 0,
  shareUrl: null,
};

/**
 * A realistic, moderately-detailed request: full requester + location
 * detail, but no related inventory item, no access instructions and no
 * photos — the common case (most maintenance requests don't have all three
 * simultaneously). Used to prove the genuine "fits without condensing"
 * path, since FULL_INPUT (every optional field populated at once) is
 * deliberately the maximal case and legitimately condenses — see the
 * "measured reality" describe block below.
 */
const MODERATE_INPUT: MaintenanceEmailInput = {
  ...FULL_INPUT,
  relatedItem: null,
  accessInstructions: null,
  photoCount: 0,
  shareUrl: null,
};

describe('buildMaintenanceEmailDraft — recipients and subject', () => {
  const draft = buildMaintenanceEmailDraft(FULL_INPUT);

  it('(1) To is the literal DC4 address; (2) CC is the literal Andrew address', () => {
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });

  it('(3) subject keeps the requester wording; (4) subject includes the request number, never the UUID', () => {
    expect(draft.subject).toBe('[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204');
  });

  it('avoids duplicated prefixes when the user pastes one in', () => {
    const d = buildMaintenanceEmailDraft({
      ...FULL_INPUT,
      subject: '[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204',
    });
    expect(d.subject.match(/\[StockPilot Maintenance/g)?.length).toBe(1);
  });

  it('recipients never appear in the BODY (they enter at the compose layer only)', () => {
    expect(draft.body).not.toContain('dc4@learn4life.org');
    expect(draft.body).not.toContain('arosas@cvwest.org');
  });
});

describe('buildMaintenanceEmailDraft — body blocks', () => {
  const body = buildMaintenanceEmailDraft(FULL_INPUT).body;

  it('(5) description block present with (15) line breaks intact', () => {
    expect(body).toContain('ISSUE DESCRIPTION');
    expect(body).toContain('since yesterday afternoon.\nThe room is becoming too warm');
  });
  it('(6) requester name; (7) site; (8) building and room', () => {
    expect(body).toContain('Name: Jane Smith');
    expect(body).toContain('Site: Fresno Learning Center');
    expect(body).toContain('Building: Main Building');
    expect(body).toContain('Room or Area: Room 204');
  });
  it('(9) related item block with SKU + barcode + model number + warehouse + location + app link; NO asset-tag line ever (audit Q6)', () => {
    expect(body).toContain('Item: Wall-mounted HVAC unit');
    expect(body).toContain('SKU: HVAC-WALL-204');
    expect(body).toContain('Barcode: 012345678905');
    expect(body).toContain('Model Number: ACX-9000');
    expect(body).toContain('Warehouse: Fresno Distribution Center');
    expect(body).toContain('Location: Room 204 Closet');
    expect(body).toContain('StockPilot Item: https://stockpilotusa.com/dashboard/inventory/');
    expect(body).not.toContain('Asset Tag');
  });
  it('MUTATION SELF-CHECK: dropping a §8 item field (e.g. barcode omitted from the input) omits only that line, never a bare label or "null"', () => {
    const b = buildMaintenanceEmailDraft({
      ...FULL_INPUT,
      relatedItem: { ...FULL_INPUT.relatedItem!, barcode: null, warehouseName: null },
    }).body;
    expect(b).toContain('Item: Wall-mounted HVAC unit');
    expect(b).toContain('Model Number: ACX-9000');
    expect(b).toContain('Location: Room 204 Closet');
    expect(b).not.toContain('Barcode');
    expect(b).not.toContain('Warehouse:');
    expect(b).not.toMatch(/\bnull\b/);
  });
  it('(10) related order block renders when provided', () => {
    const withOrder = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: 'Room 12 teacher',
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(withOrder).toContain('Order: SO-000021');
    expect(withOrder).toContain('StockPilot Order: https://stockpilotusa.com/dashboard/orders/');
  });
  it('related rental block identifies by borrower + items — never a fake R- handle (audit Q11)', () => {
    const withRental = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedRental: {
        itemNames: ['Projector', 'HDMI cable'],
        borrowerName: 'Sam Lee',
        url: 'https://stockpilotusa.com/dashboard/rentals/33333333-3333-3333-3333-333333333333',
      },
    }).body;
    expect(withRental).toContain('Rental of: Projector, HDMI cable');
    expect(withRental).toContain('Borrower: Sam Lee');
    expect(withRental).not.toMatch(/\bR-\d/);
  });
  it('(11) photo count; (12) secure share link when available', () => {
    expect(body).toContain('3 photos were uploaded with this request.');
    expect(body).toContain('View request photos:\nhttps://stockpilotusa.com/m/abcdef1234567890');
    expect(body).toContain('The requester may also attach the photos directly to this email before sending.');
  });
  it('uses singular copy for one photo', () => {
    expect(buildMaintenanceEmailDraft({ ...FULL_INPUT, photoCount: 1 }).body).toContain(
      '1 photo was uploaded with this request.',
    );
  });
  it('(13) photo section omitted entirely when there are no photos', () => {
    const b = buildMaintenanceEmailDraft(MINIMAL_INPUT).body;
    expect(b).not.toContain('PHOTOS');
    expect(b).not.toContain('View request photos');
  });
  it('(17)(18) never renders undefined / null / Invalid Date / [object Object] or empty labels', () => {
    const b = buildMaintenanceEmailDraft(MINIMAL_INPUT).body;
    expect(b).not.toContain('undefined');
    expect(b).not.toMatch(/\bnull\b/);
    expect(b).not.toContain('Invalid Date');
    expect(b).not.toContain('[object Object]');
    // Whole optional blocks are omitted, not printed empty:
    expect(b).not.toContain('LOCATION');
    expect(b).not.toContain('RELATED STOCKPILOT RECORD');
    expect(b).not.toContain('ADDITIONAL ACCESS INFORMATION');
    expect(b).not.toContain('Email:');
    expect(b).not.toContain('Phone:');
  });
  it('ends with the reply-thread guidance and the StockPilot footer', () => {
    expect(body).toContain(
      'Please reply to this email thread for updates so the responses remain attached to the same Zendesk ticket.',
    );
    expect(body.trim().endsWith('StockPilot Request: MR-2026-000123')).toBe(true);
  });
  it('never claims a send happened (forbidden-phrase sweep, brief section 20)', () => {
    for (const phrase of [
      'Ticket created',
      'Request submitted to Zendesk',
      'DC4 notified',
      'Andrew notified',
      'Ticket assigned',
      'Email sent',
    ]) {
      expect(body).not.toContain(phrase);
    }
  });
});

describe('prepareMaintenanceEmail — transport', () => {
  const prepared = prepareMaintenanceEmail(FULL_INPUT);

  it('(19) Outlook URL: cloud.microsoft base, single mailtouri, name-addr chips', () => {
    expect(prepared.outlookUrl.startsWith(`${OUTLOOK_COMPOSE_BASE}?mailtouri=`)).toBe(true);
    const { to, params } = decodeCompose(prepared.outlookUrl);
    expect(to).toBe('Fresno Warehouse DC4 <dc4@learn4life.org>');
    expect(params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
  });
  it('(14)(16) special characters encode once — decode recovers the exact body, %20 never +', () => {
    const { params } = decodeCompose(prepared.outlookUrl);
    expect(params.subject).toBe(prepared.draft.subject);
    expect(params.body).toBe(prepared.draft.body);
    expect(prepared.outlookUrl).not.toContain('+');
  });
  it('(20) mailto URL is bare-address RFC 6068 with cc/subject/body params', () => {
    expect(prepared.mailtoUrl.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org&subject=')).toBe(true);
  });
  it('(21) clipboard carries labelled TO and CC blocks', () => {
    expect(prepared.clipboardText).toContain('TO: dc4@learn4life.org');
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
  });
  it('measured reality: a MAXIMALLY-detailed request (every optional field populated at once, matching the brief\'s own worked example) legitimately condenses', () => {
    // Discovered by measuring the brief's section-15 illustrative body
    // through the REAL, tenant-verified, double-encoded transport
    // (composeOutlookWebUrl): a fully-populated request's Outlook URL runs
    // well past DRAFT_URL_LIMIT (1800) even in the densest reasonable
    // formatting. That is the condense mechanism doing exactly its job —
    // see the "fits without condensing" case right below for a realistic
    // (not maximal) request, which does NOT need to condense.
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.linkFits).toBe(true);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(prepared.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
  });

  it('fits without condensing: a realistic, moderately-detailed request (no related item, no access instructions, no photos) uses the FULL draft', () => {
    const moderate = prepareMaintenanceEmail(MODERATE_INPUT);
    expect(moderate.draft.condensed).toBe(false);
    expect(moderate.linkFits).toBe(true);
    expect(moderate.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(moderate.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    // Still carries the full requester/location/description detail — only
    // the fields that were genuinely absent from the input are missing:
    expect(moderate.draft.body).toContain('Building: Main Building');
    expect(moderate.draft.body).toContain('Email: jane.smith@learn4life.org');
    expect(moderate.draft.body).not.toContain('RELATED STOCKPILOT RECORD');
    expect(moderate.draft.body).not.toContain('PHOTOS');
  });
});

describe('prepareMaintenanceEmail — condense policy (audit Q13)', () => {
  const LONG = { ...FULL_INPUT, description: 'Detail line. '.repeat(400) };

  it('oversized input condenses: keeps number/requester/site/truncated description/share link, drops location + related + access', () => {
    const prepared = prepareMaintenanceEmail(LONG);
    expect(prepared.draft.condensed).toBe(true);
    const b = prepared.draft.body;
    expect(b).toContain('StockPilot Request: MR-2026-000123');
    expect(b).toContain('Name: Jane Smith');
    expect(b).toContain('Site: Fresno Learning Center');
    expect(b).toContain('View request photos:\nhttps://stockpilotusa.com/m/abcdef1234567890');
    expect(b).not.toContain('Building:');
    expect(b).not.toContain('RELATED STOCKPILOT RECORD');
    expect(b).not.toContain('ADDITIONAL ACCESS INFORMATION');
  });
  it('the disclosure sentence is byte-intact and contiguous', () => {
    const b = prepareMaintenanceEmail(LONG).draft.body;
    expect(b).toContain(MAINTENANCE_CONDENSED_DISCLOSURE);
  });
  it('clipboardText is ALWAYS the FULL draft even when the URLs condensed', () => {
    const prepared = prepareMaintenanceEmail(LONG);
    expect(prepared.clipboardText).toContain('Building: Main Building');
    expect(prepared.clipboardText).toContain('ADDITIONAL ACCESS INFORMATION');
  });
  it('both chosen URLs measure within DRAFT_URL_LIMIT when linkFits is true', () => {
    const prepared = prepareMaintenanceEmail(LONG);
    if (prepared.linkFits) {
      expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
      expect(prepared.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    }
  });
  it('mutation self-check #4: a merely-oversized (non-pathological) request condenses and STILL fits — linkFits stays true', () => {
    // Pinned as an unconditional assertion (not the soft `if` above) so a
    // mutation that abandons re-measurement after condensing, or that
    // condenses without actually shrinking the URL, is caught outright.
    const prepared = prepareMaintenanceEmail(LONG);
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.linkFits).toBe(true);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(prepared.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
  });
  it('pathological names defeat even the condensed draft -> linkFits false (UI must open NOTHING)', () => {
    const prepared = prepareMaintenanceEmail({ ...LONG, requesterName: 'X'.repeat(2000) });
    expect(prepared.linkFits).toBe(false);
  });
});

describe('mutation self-check: condense-first, never truncate-first', () => {
  it('a moderately-sized request is NEVER condensed even though its description alone exceeds the condensed truncation budget', () => {
    // 255 chars: comfortably inside the description-truncation budget (400,
    // fix wave 1 (2d) — see CONDENSED_DESCRIPTION_CHARS's own comment) used
    // by condensed mode, but this also proves condensing is decided by
    // MEASURING THE URL, not by description length — a naive implementation
    // that truncates whenever description.length is "long" would condense
    // this input even though the full compose links fit easily (re-measured
    // after fix wave 1 at outlookUrl.length === 1714, 86 chars of headroom
    // under the 1800 limit). Built on MODERATE_INPUT (not FULL_INPUT): FULL_INPUT is
    // deliberately the maximal, every-field-populated case and legitimately
    // condenses on size alone (see "measured reality" above) — this test
    // isolates the description-length question from that overall-size
    // question.
    const input: MaintenanceEmailInput = { ...MODERATE_INPUT, description: 'Detail sentence. '.repeat(15) };
    const prepared = prepareMaintenanceEmail(input);
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.draft.body).toBe(buildMaintenanceEmailDraft(input).body);
  });

  it('never truncates mid-sentence: the condensed cut lands at a word boundary, never inside a word, and always ends in an ellipsis', () => {
    const originalDescription = 'Detail line. '.repeat(400);
    const LONG = { ...FULL_INPUT, description: originalDescription };
    const condensedDraft = buildMaintenanceEmailDraft(LONG, { condensed: true });
    // Fix wave 1 (1b): `section()` now emits a blank line after every
    // heading (§15's own sectioning), so the description sits two newlines
    // after 'ISSUE DESCRIPTION', not one.
    const match = condensedDraft.body.match(/ISSUE DESCRIPTION\n\n([\s\S]*?)\n\n/);
    expect(match).not.toBeNull();
    const description = match?.[1] ?? '';
    expect(description.endsWith('...')).toBe(true);

    // The cut text (minus its ellipsis) must be an exact PREFIX of the
    // original description, and the character immediately following that
    // prefix in the ORIGINAL text must be whitespace (or the prefix must be
    // the entire original) — i.e. the cut landed exactly between two words,
    // never in the middle of one. A mid-word cut (e.g. truncating "line."
    // to "lin") would fail this: the next original character would be a
    // letter, not a space.
    const withoutEllipsis = description.slice(0, -3);
    expect(originalDescription.startsWith(withoutEllipsis)).toBe(true);
    const nextChar = originalDescription[withoutEllipsis.length];
    expect(nextChar === ' ' || nextChar === undefined).toBe(true);
  });
});

describe('mutation self-check: empty sections are OMITTED, never rendered blank', () => {
  it('a request with absolutely nothing optional set renders no empty labelled block anywhere', () => {
    const b = buildMaintenanceEmailDraft(MINIMAL_INPUT).body;
    for (const heading of [
      'LOCATION',
      'RELATED STOCKPILOT RECORD',
      'ADDITIONAL ACCESS INFORMATION',
      'PHOTOS',
    ]) {
      expect(b).not.toContain(heading);
    }
    // REQUESTER still renders (Name is always present) but carries none of
    // the optional lines:
    expect(b).toContain('REQUESTER');
    expect(b).toContain('Name: Jane Smith');
    expect(b).not.toContain('Site:');
    expect(b).not.toContain('Department:');
    // No stray triple-blank-line from a heading whose body collapsed away:
    expect(b).not.toMatch(/\n{3,}/);
  });
});

describe('mutation self-check: subject-prefix idempotency is not merely case-sensitive luck', () => {
  it('a differently-cased or re-derived prefix still collapses to exactly one', () => {
    const d = buildMaintenanceEmailDraft({
      ...FULL_INPUT,
      subject: '[stockpilot maintenance MR-2026-000123]   Air conditioner is not working in Room 204',
    });
    expect(d.subject.match(/\[StockPilot Maintenance/gi)?.length).toBe(1);
    expect(d.subject).toBe('[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204');
  });
});

describe('display-name throw safety (Task 4 forward-note) — requester/site can NEVER reach a display-name slot', () => {
  it('a requester name and site name containing every RFC 5322 special that composeOutlookWebUrl rejects does not throw, and does not alter the To/Cc chips', () => {
    const unsafe = 'Evil <injected@attacker.test>, "quoted"; @nope';
    const input: MaintenanceEmailInput = {
      ...FULL_INPUT,
      requesterName: unsafe,
      siteName: unsafe,
    };
    expect(() => prepareMaintenanceEmail(input)).not.toThrow();
    const prepared = prepareMaintenanceEmail(input);
    const { to, params } = decodeCompose(prepared.outlookUrl);
    // The To/Cc chips are STILL the frozen constants — unsafe requester/site
    // text never reaches a display-name slot, it can only land in the body:
    expect(to).toBe('Fresno Warehouse DC4 <dc4@learn4life.org>');
    expect(params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
    expect(prepared.draft.body).toContain(`Name: ${unsafe}`);
  });

  it('a requester name long enough to overflow even the condensed draft still never throws — it only ever fails via linkFits:false', () => {
    const LONG = { ...FULL_INPUT, description: 'Detail line. '.repeat(400) };
    expect(() => prepareMaintenanceEmail({ ...LONG, requesterName: 'X'.repeat(5000) })).not.toThrow();
  });
});

describe('type-level: the builder accepts NO recipient input', () => {
  it('MaintenanceEmailInput has no to/cc/bcc field — TypeScript rejects one at the call site', () => {
    // @ts-expect-error — `to` is not a key of MaintenanceEmailInput; recipients
    // come ONLY from L4L_MAINTENANCE_EMAIL inside the builder.
    const withTo: MaintenanceEmailInput = { ...FULL_INPUT, to: 'attacker@evil.test' };
    // @ts-expect-error — same for `cc`.
    const withCc: MaintenanceEmailInput = { ...FULL_INPUT, cc: 'attacker@evil.test' };
    // Runtime confirmation that even if such a key were smuggled in via `any`,
    // the builder ignores it and still uses only the frozen constant:
    expect(buildMaintenanceEmailDraft(withTo as MaintenanceEmailInput).to).toBe('dc4@learn4life.org');
    expect(buildMaintenanceEmailDraft(withCc as MaintenanceEmailInput).cc).toBe('arosas@cvwest.org');
  });
});

describe('fix wave 1 (2a): NaN-safe photoCount guard', () => {
  it('a NaN photoCount (bad DB data feeding this from Task 8) omits PHOTOS entirely — never renders "NaN photos..."', () => {
    const b = buildMaintenanceEmailDraft({ ...FULL_INPUT, photoCount: NaN }).body;
    expect(b).not.toContain('PHOTOS');
    expect(b).not.toContain('NaN');
  });
});

describe('fix wave 1 (2b): a blank requestNumber omits the bracket prefix and the footer request-number line', () => {
  it('subject has no bracket prefix at all when requestNumber is blank — never a bare "[StockPilot Maintenance ] "', () => {
    const d = buildMaintenanceEmailDraft({ ...MINIMAL_INPUT, requestNumber: '' });
    expect(d.subject).toBe('Door hinge squeaks badly');
    expect(d.subject).not.toContain('StockPilot Maintenance');
    expect(d.subject).not.toContain('[');
  });

  it('footer omits the "StockPilot Request:" line when requestNumber is blank/whitespace-only, but keeps "Generated from StockPilot."', () => {
    const d = buildMaintenanceEmailDraft({ ...MINIMAL_INPUT, requestNumber: '   ' });
    expect(d.body).not.toContain('StockPilot Request:');
    expect(d.body.trim().endsWith('Generated from StockPilot.')).toBe(true);
  });
});

describe('fix wave 1 (2c): subject-prefix dedup handles Re:/Fwd:, a pasted-twice prefix, and an optional space, via a loop', () => {
  it('"[StockPilot Maintenance] AC broken" (no space before the bracket) still dedupes to exactly one prefix', () => {
    const d = buildMaintenanceEmailDraft({ ...FULL_INPUT, subject: '[StockPilot Maintenance] AC broken' });
    expect(d.subject.match(/\[StockPilot Maintenance/g)?.length).toBe(1);
    expect(d.subject).toBe('[StockPilot Maintenance MR-2026-000123] AC broken');
  });

  it('a prefix pasted twice collapses to exactly one (proves the LOOP, not a single replace)', () => {
    const d = buildMaintenanceEmailDraft({
      ...FULL_INPUT,
      subject:
        '[StockPilot Maintenance MR-2026-000123] [StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204',
    });
    expect(d.subject.match(/\[StockPilot Maintenance/g)?.length).toBe(1);
    expect(d.subject).toBe('[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204');
  });

  it('"Re: [StockPilot Maintenance MR-1] AC broken" — a leading reply-chain marker on an already-prefixed subject still dedupes to exactly one', () => {
    const d = buildMaintenanceEmailDraft({ ...FULL_INPUT, subject: 'Re: [StockPilot Maintenance MR-1] AC broken' });
    expect(d.subject.match(/\[StockPilot Maintenance/g)?.length).toBe(1);
    expect(d.subject).toBe('[StockPilot Maintenance MR-2026-000123] AC broken');
  });
});

describe('fix wave 1 (2e): related-record groups (item/order/rental) are blank-line separated under the shared heading', () => {
  it('item + order + rental all present at once are separated by a blank line, never glued line-to-line', () => {
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedItem: {
        name: 'Wall-mounted HVAC unit',
        sku: 'HVAC-WALL-204',
        barcode: '012345678905',
        modelNumber: 'ACX-9000',
        warehouseName: 'Fresno Distribution Center',
        locationName: 'Room 204 Closet',
        url: 'https://stockpilotusa.com/dashboard/inventory/11111111-1111-1111-1111-111111111111',
      },
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: 'Room 12 teacher',
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
      relatedRental: {
        itemNames: ['Projector', 'HDMI cable'],
        borrowerName: 'Sam Lee',
        url: 'https://stockpilotusa.com/dashboard/rentals/33333333-3333-3333-3333-333333333333',
      },
    }).body;
    expect(body).toContain(
      'StockPilot Item: https://stockpilotusa.com/dashboard/inventory/11111111-1111-1111-1111-111111111111\n\nOrder: SO-000021',
    );
    expect(body).toContain(
      'StockPilot Order: https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222\n\nRental of: Projector, HDMI cable',
    );
    // Never three-in-a-row — that would mean an extra stray blank line leaked
    // in alongside the intentional group separator:
    expect(body).not.toMatch(/\n{3,}/);
  });
});

describe('golden — one complete, fully-populated email, literal-pinned', () => {
  // FULL_INPUT has every optional field populated at once — the maximal
  // case — and, per the "measured reality" test above, that legitimately
  // condenses. Both the subject and the condensed body are pinned as
  // independent literal strings (not derived by calling the module under
  // test), and the URLs/clipboard are cross-checked two ways: against a
  // hardcoded literal AND by decoding the Outlook URL back apart.
  const EXPECTED_SUBJECT =
    '[StockPilot Maintenance MR-2026-000123] Air conditioner is not working in Room 204';
  // Fix wave 1 (1a/1b): plain 'MAINTENANCE REQUEST' heading (no '— StockPilot'
  // suffix) + a blank line after every heading (§15's own sectioning) — a
  // byte-for-byte wash: (1a) saves the 35 chars (1b) costs on this exact
  // fixture (both the heading text and every section() call site changed,
  // so this golden was fully re-measured through the real transport, not
  // hand-patched).
  const EXPECTED_CONDENSED_BODY = [
    'MAINTENANCE REQUEST',
    '',
    'StockPilot Request: MR-2026-000123',
    '',
    'REQUESTER',
    '',
    'Name: Jane Smith',
    'Site: Fresno Learning Center',
    '',
    'ISSUE DESCRIPTION',
    '',
    'The air conditioner has been blowing warm air since yesterday afternoon.\nThe room is becoming too warm for normal use.',
    '',
    MAINTENANCE_CONDENSED_DISCLOSURE,
    '',
    'PHOTOS',
    'View request photos:',
    'https://stockpilotusa.com/m/abcdef1234567890',
    '',
    'Generated from StockPilot.',
    'StockPilot Request: MR-2026-000123',
  ].join('\n');

  it('FULL_INPUT (maximal): subject, condensed body, both URLs and clipboard text match byte-for-byte', () => {
    const prepared = prepareMaintenanceEmail(FULL_INPUT);

    expect(prepared.draft.subject).toBe(EXPECTED_SUBJECT);
    expect(prepared.draft.body).toBe(EXPECTED_CONDENSED_BODY);
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.linkFits).toBe(true);

    // Independent literal pin (copied from a verified, decoded run — not
    // derived from OUTLOOK_COMPOSE_BASE or from calling the module under
    // test to build the expectation):
    expect(prepared.outlookUrl).toBe(
      'https://outlook.cloud.microsoft/mail/deeplink/compose?mailtouri=mailto%3AFresno%2520Warehouse%2520DC4%2520%253Cdc4%2540learn4life.org%253E%3Fcc%3DAndrew%2520Rosas%2520%253Carosas%2540cvwest.org%253E%26subject%3D%255BStockPilot%2520Maintenance%2520MR-2026-000123%255D%2520Air%2520conditioner%2520is%2520not%2520working%2520in%2520Room%2520204%26body%3DMAINTENANCE%2520REQUEST%250A%250AStockPilot%2520Request%253A%2520MR-2026-000123%250A%250AREQUESTER%250A%250AName%253A%2520Jane%2520Smith%250ASite%253A%2520Fresno%2520Learning%2520Center%250A%250AISSUE%2520DESCRIPTION%250A%250AThe%2520air%2520conditioner%2520has%2520been%2520blowing%2520warm%2520air%2520since%2520yesterday%2520afternoon.%250AThe%2520room%2520is%2520becoming%2520too%2520warm%2520for%2520normal%2520use.%250A%250AThis%2520message%2520was%2520shortened%2520because%2520the%2520full%2520request%2520details%2520did%2520not%2520fit%2520in%2520a%2520compose%2520link.%2520The%2520complete%2520request%2520is%2520in%2520StockPilot%2520under%2520the%2520request%2520number%2520above.%250A%250APHOTOS%250AView%2520request%2520photos%253A%250Ahttps%253A%252F%252Fstockpilotusa.com%252Fm%252Fabcdef1234567890%250A%250AGenerated%2520from%2520StockPilot.%250AStockPilot%2520Request%253A%2520MR-2026-000123',
    );
    const { to, params } = decodeCompose(prepared.outlookUrl);
    expect(to).toBe('Fresno Warehouse DC4 <dc4@learn4life.org>');
    expect(params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
    expect(params.subject).toBe(prepared.draft.subject);
    expect(params.body).toBe(prepared.draft.body);

    expect(prepared.mailtoUrl).toBe(
      'mailto:dc4@learn4life.org?cc=arosas%40cvwest.org&subject=%5BStockPilot%20Maintenance%20MR-2026-000123%5D%20Air%20conditioner%20is%20not%20working%20in%20Room%20204&body=MAINTENANCE%20REQUEST%0A%0AStockPilot%20Request%3A%20MR-2026-000123%0A%0AREQUESTER%0A%0AName%3A%20Jane%20Smith%0ASite%3A%20Fresno%20Learning%20Center%0A%0AISSUE%20DESCRIPTION%0A%0AThe%20air%20conditioner%20has%20been%20blowing%20warm%20air%20since%20yesterday%20afternoon.%0AThe%20room%20is%20becoming%20too%20warm%20for%20normal%20use.%0A%0AThis%20message%20was%20shortened%20because%20the%20full%20request%20details%20did%20not%20fit%20in%20a%20compose%20link.%20The%20complete%20request%20is%20in%20StockPilot%20under%20the%20request%20number%20above.%0A%0APHOTOS%0AView%20request%20photos%3A%0Ahttps%3A%2F%2Fstockpilotusa.com%2Fm%2Fabcdef1234567890%0A%0AGenerated%20from%20StockPilot.%0AStockPilot%20Request%3A%20MR-2026-000123',
    );

    expect(prepared.clipboardText).toBe(
      [
        'TO: dc4@learn4life.org',
        'CC: arosas@cvwest.org',
        `SUBJECT: ${EXPECTED_SUBJECT}`,
        '',
        'MESSAGE:',
        // Clipboard is ALWAYS the full (uncondensed) draft, never the
        // condensed one, even though the URLs above are condensed:
        buildMaintenanceEmailDraft(FULL_INPUT).body,
      ].join('\n'),
    );
    expect(prepared.clipboardText).toContain('LOCATION\n\nBuilding: Main Building');
    expect(prepared.clipboardText).toContain('RELATED STOCKPILOT RECORD');
    expect(prepared.clipboardText).toContain('ADDITIONAL ACCESS INFORMATION');
  });

  it('MODERATE_INPUT (realistic, non-maximal): the FULL draft path, pinned byte-for-byte', () => {
    const prepared = prepareMaintenanceEmail(MODERATE_INPUT);
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.linkFits).toBe(true);

    expect(prepared.draft.body).toBe(
      [
        'MAINTENANCE REQUEST',
        '',
        'StockPilot Request: MR-2026-000123',
        'Issue: Air conditioner is not working in Room 204',
        'Category: Heating or air conditioning',
        'Priority: High',
        'Submitted: August 5, 2026 at 9:15 AM',
        '',
        'REQUESTER',
        '',
        'Name: Jane Smith',
        'Email: jane.smith@learn4life.org',
        'Phone: (555) 555-0199',
        'Site: Fresno Learning Center',
        'Department: Operations',
        '',
        'LOCATION',
        '',
        'Building: Main Building',
        'Room or Area: Room 204',
        '',
        'ISSUE DESCRIPTION',
        '',
        'The air conditioner has been blowing warm air since yesterday afternoon.\nThe room is becoming too warm for normal use.',
        '',
        'Please reply to this email thread for updates so the responses remain attached to the same Zendesk ticket.',
        '',
        'Generated from StockPilot.',
        'StockPilot Request: MR-2026-000123',
      ].join('\n'),
    );

    const { to, params } = decodeCompose(prepared.outlookUrl);
    expect(to).toBe('Fresno Warehouse DC4 <dc4@learn4life.org>');
    expect(params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
    expect(params.subject).toBe(EXPECTED_SUBJECT);
    expect(params.body).toBe(prepared.draft.body);
    expect(prepared.mailtoUrl.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org&subject=')).toBe(
      true,
    );
    expect(prepared.clipboardText).toBe(
      ['TO: dc4@learn4life.org', 'CC: arosas@cvwest.org', `SUBJECT: ${EXPECTED_SUBJECT}`, '', 'MESSAGE:', prepared.draft.body].join(
        '\n',
      ),
    );
  });
});
