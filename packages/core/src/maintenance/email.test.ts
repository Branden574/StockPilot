import { describe, expect, it } from 'vitest';

import {
  buildMaintenanceEmailDraft,
  prepareMaintenanceEmail,
  MAINTENANCE_CONDENSED_DISCLOSURE,
  type MaintenanceEmailInput,
} from './email';
import { OUTLOOK_COMPOSE_BASE, DRAFT_URL_LIMIT } from '../email/outlook-compose';
import { L4L_MAINTENANCE_RECIPIENTS } from './constants';
import { maintenanceEmailRecipients } from './recipients';

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
  // The COMPILED pair — recipients are builder INPUT since the per-org
  // routing feature; these fixtures pin that the compiled value still
  // produces byte-identical output to the pre-feature constants-reading
  // builder.
  recipients: L4L_MAINTENANCE_RECIPIENTS,
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
  recipients: L4L_MAINTENANCE_RECIPIENTS,
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
  it('(10) related order block renders when provided, including §8\'s delivery site + relevant item names (fix wave 2 / I2 — the two order fields the audit found missing)', () => {
    const withOrder = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: 'Room 12 teacher',
        deliverySiteName: 'Fresno Learning Center',
        itemNames: ['Copy paper', 'Dry erase markers'],
        totalItemCount: 2,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(withOrder).toContain('Order: SO-000021');
    expect(withOrder).toContain('Requested for: Room 12 teacher');
    expect(withOrder).toContain('Delivery Site: Fresno Learning Center');
    // Placed BEFORE the StockPilot Order link line (mirrors how the
    // relatedItem block's own Warehouse/Location fields sit before ITS
    // link line) — pinning the exact adjacency proves the ordering, not
    // just the lines' mere presence.
    expect(withOrder).toContain(
      'Items: Copy paper, Dry erase markers\nStockPilot Order: https://stockpilotusa.com/dashboard/orders/',
    );
  });
  it('MUTATION GUARD (§8 / fix wave 2): Delivery Site and Items are each omitted individually when blank — never a bare label, never "null"', () => {
    const b = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: [],
        totalItemCount: 0,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(b).not.toContain('Delivery Site');
    expect(b).not.toContain('Items:');
    expect(b).not.toMatch(/\bnull\b/);
    expect(b).toContain('Order: SO-000021\nStockPilot Order:');
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
        // Fix wave 2 (I2): left blank on purpose — this test's own job is
        // the blank-line GROUP separator, not §8's order-field content
        // (that's pinned separately above). Blank inputs here means neither
        // new line renders, so 'StockPilot Order' stays the group's last
        // line and this test's byte-pinned boundary below is unaffected by
        // the I2 field addition.
        deliverySiteName: null,
        itemNames: [],
        totalItemCount: 0,
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

describe('fix wave 3 (task 17): truncated order item names disclosure marker', () => {
  it('15 item lines: exactly 10 names + marker showing 5 more', () => {
    const fifteenItems = Array.from({ length: 15 }, (_, i) => `Item ${i + 1}`);
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: fifteenItems.slice(0, 10),
        totalItemCount: 15,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(body).toContain('Items: Item 1, Item 2, Item 3, Item 4, Item 5, Item 6, Item 7, Item 8, Item 9, Item 10 (+5 more)');
  });

  it('exactly 10 item lines: names, NO marker', () => {
    const tenItems = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: tenItems,
        totalItemCount: 10,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(body).toContain('Items: Item 1, Item 2, Item 3, Item 4, Item 5, Item 6, Item 7, Item 8, Item 9, Item 10');
    expect(body).not.toContain('(+');
  });

  it('3 item lines: names, no marker', () => {
    const threeItems = ['Widget A', 'Widget B', 'Widget C'];
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: threeItems,
        totalItemCount: 3,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(body).toContain('Items: Widget A, Widget B, Widget C');
    expect(body).not.toContain('(+');
  });

  it('0 item lines: Items line omitted entirely', () => {
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: [],
        totalItemCount: 0,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(body).not.toContain('Items:');
  });

  it('MUTATION CHECK #1: dropping the marker makes the 15-line test fail — marker is required for truncation', () => {
    const fifteenItems = Array.from({ length: 15 }, (_, i) => `Item ${i + 1}`);
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: fifteenItems.slice(0, 10),
        totalItemCount: 15,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    // Without the marker, this would fail:
    expect(body).toContain('(+5 more)');
  });

  it('MUTATION CHECK #2: emitting marker unconditionally makes the exactly-10 test fail — marker omitted when nothing truncated', () => {
    const tenItems = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}`);
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: tenItems,
        totalItemCount: 10,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    // With unconditional marker, this would fail:
    expect(body).not.toContain('(+');
  });

  it('marker is omitted when blank/absent item names drop the Items line entirely (totalItemCount non-zero but itemNames empty)', () => {
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: [],
        totalItemCount: 5,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    // No Items line at all, never a bare label with just the marker:
    expect(body).not.toContain('Items:');
    expect(body).not.toContain('(+');
  });

  it('marker appears even when some names in itemNames are blank (after filter)', () => {
    // itemNames can include blanks (though the builder filters them); totalItemCount
    // reflects the real count from the DB. This verifies the marker appears based on
    // the totalItemCount vs filtered itemNames.length, not some other calculation.
    const body = buildMaintenanceEmailDraft({
      ...MINIMAL_INPUT,
      relatedOrder: {
        handle: 'SO-000021',
        requestedFor: null,
        deliverySiteName: null,
        itemNames: ['Item 1', 'Item 2'],
        totalItemCount: 5,
        url: 'https://stockpilotusa.com/dashboard/orders/22222222-2222-2222-2222-222222222222',
      },
    }).body;
    expect(body).toContain('Items: Item 1, Item 2 (+3 more)');
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

/** Opaque-scheme decode for the native deep link (the exact string the mobile
 *  app hands to Linking.openURL). Slice at the first '?', never new URL(). */
function decodeMobileCompose(url: string): Record<string, string> {
  const q = url.indexOf('?');
  const params: Record<string, string> = {};
  if (q === -1) return params;
  for (const pair of url.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return params;
}

/**
 * THE ACCEPTANCE GATE, at the builder level: the native mobile compose URL
 * must carry the mandatory CC for EVERY fixture the web transport is tested
 * with — the minimal case, the moderate (uncondensed) case, the maximal case
 * that condenses, the oversized case, and the pathological case that fits
 * nothing at all. The requester creates the ticket; the fixed cc address gets
 * the copy. A compose screen that opens without it is a SILENT workflow
 * break, so it is pinned per fixture rather than once on a happy path.
 */
describe('prepareMaintenanceEmail — native mobile transport (CC ACCEPTANCE GATE, all fixtures)', () => {
  const LONG = { ...FULL_INPUT, description: 'Detail line. '.repeat(400) };
  const PATHOLOGICAL = { ...LONG, requesterName: 'X'.repeat(2000) };

  const FIXTURES: { name: string; input: MaintenanceEmailInput }[] = [
    { name: 'MINIMAL (nothing optional set)', input: MINIMAL_INPUT },
    { name: 'MODERATE (fits without condensing)', input: MODERATE_INPUT },
    { name: 'FULL (maximal — legitimately condenses)', input: FULL_INPUT },
    { name: 'LONG (oversized — condenses and still fits)', input: LONG },
    { name: 'PATHOLOGICAL (linkFits false — nothing may be opened)', input: PATHOLOGICAL },
  ];

  for (const { name, input } of FIXTURES) {
    it(`${name}: outlookMobileUrl carries the mandatory CC, bare and byte-exact`, () => {
      const prepared = prepareMaintenanceEmail(input);
      expect(prepared.outlookMobileUrl.startsWith('ms-outlook://compose?')).toBe(true);
      const params = decodeMobileCompose(prepared.outlookMobileUrl);
      expect(params.cc).toBe('arosas@cvwest.org');
      expect(params.to).toBe('dc4@learn4life.org');
      // Identical recipients to the draft the web path sends — one builder,
      // one source of truth, two transports:
      expect(params.cc).toBe(prepared.draft.cc);
      expect(params.to).toBe(prepared.draft.to);
    });

    it(`${name}: subject and body are the SAME draft the web path sends (never rebuilt for mobile)`, () => {
      const prepared = prepareMaintenanceEmail(input);
      const params = decodeMobileCompose(prepared.outlookMobileUrl);
      expect(params.subject).toBe(prepared.draft.subject);
      expect(params.body).toBe(prepared.draft.body);
      expect(prepared.outlookMobileUrl).not.toContain('+');
    });

    it(`${name}: the native URL never exceeds the web URL, so the DEFAULT web-fitted guard covers it unmeasured`, () => {
      // These fixtures all run the DEFAULT transport (outlook-web), under
      // which the native url is deliberately not part of the fit decision.
      // This inequality is what makes that safe: a draft fitted for the web
      // url transitively fits the strictly-shorter native one. It is NO
      // LONGER the reason the native url goes unmeasured everywhere — a
      // caller that declares `transport: 'outlook-native'` now has the fit
      // run against the native url itself (see the transport-option
      // describe below); the inequality only justifies the default's
      // direction, and the reverse direction is false, which that describe
      // pins.
      const prepared = prepareMaintenanceEmail(input);
      expect(prepared.outlookMobileUrl.length).toBeLessThan(prepared.outlookUrl.length);
      if (prepared.linkFits) {
        expect(prepared.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
      }
    });
  }

  it('WEB IS UNCHANGED: outlookUrl is still the https OWA deep link with its name-addr chips', () => {
    const prepared = prepareMaintenanceEmail(FULL_INPUT);
    expect(prepared.outlookUrl.startsWith(`${OUTLOOK_COMPOSE_BASE}?mailtouri=`)).toBe(true);
    const { to, params } = decodeCompose(prepared.outlookUrl);
    expect(to).toBe('Fresno Warehouse DC4 <dc4@learn4life.org>');
    expect(params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
    // The native URL is an ADDITION, never a rename of the web one:
    expect(prepared.outlookMobileUrl).not.toBe(prepared.outlookUrl);
  });

  it('an unsafe requester/site name cannot reach the native URL either — recipients stay the frozen constants', () => {
    const unsafe = 'Evil <injected@attacker.test>, "quoted"; @nope';
    const prepared = prepareMaintenanceEmail({ ...FULL_INPUT, requesterName: unsafe, siteName: unsafe });
    const params = decodeMobileCompose(prepared.outlookMobileUrl);
    expect(params.to).toBe('dc4@learn4life.org');
    expect(params.cc).toBe('arosas@cvwest.org');
    // The unsafe text is BODY content (exactly as on the web path) and must
    // never appear in the RECIPIENT segment — everything before `&subject=`:
    const recipients = prepared.outlookMobileUrl.slice(0, prepared.outlookMobileUrl.indexOf('&subject='));
    expect(recipients).toBe('ms-outlook://compose?to=dc4%40learn4life.org&cc=arosas%40cvwest.org');
    expect(recipients).not.toContain('injected');
    expect(prepared.draft.body).toContain(`Name: ${unsafe}`);
  });
});

// =========================================================================
// THE TRANSPORT OPTION: fit against the url the caller will open — the
// delivery ladder's 2026-08-13 fix, mirrored here 2026-08-16.
//
// The defect: this builder condensed against the double-encoded https OWA
// url unconditionally, while a phone with Outlook installed opens
// `ms-outlook://compose`, roughly 25-30% shorter for the same body. On the
// fixture below the phone's own url sat 567 characters under the limit
// while the description was truncated at 400 characters and the category/
// priority/submitted/contact/location blocks were dropped — a body the
// native url carries WHOLE.
// =========================================================================

describe('prepareMaintenanceEmail — the transport option: fit against the url the caller will open', () => {
  /**
   * A realistic, ordinary maintenance request whose only excess is a long
   * (465-char) description — the class of input the native budget recovers.
   * Measured 2026-08-16: the FULL draft's web url is 2199 (over the 1800
   * limit — condenses under the default), while its native url is 1646 and
   * its mailto 1627 (both under — the full body fits a phone).
   */
  const REALISTIC_LONG: MaintenanceEmailInput = {
    ...MODERATE_INPUT,
    requestNumber: 'MR-2026-000456',
    subject: 'Hallway heater grinding and overheating near Room 118',
    description: [
      'The heating unit in the main hallway outside Room 118 has been making a loud grinding noise since Monday morning.',
      'It runs for about ten minutes, shuts off with a bang, and then restarts on its own a few minutes later.',
      'The thermostat on the wall reads 81 degrees even though it is set to 72, and the air coming out of the vent is cold.',
      'Two staff members have reported headaches from the noise, and the afternoon study group has been moved to the library as a result.',
    ].join(' '),
  };

  it('THE DEFAULT IS THE WEB URL, and it is fitted against the WEB url — flipping the default fails here', () => {
    const prepared = prepareMaintenanceEmail(REALISTIC_LONG);
    expect(prepared.transport).toBe('outlook-web');
    // Under the web budget this input condenses, and the fitted url is the
    // web one. A default flipped to 'outlook-native' would leave the full
    // draft in place with outlookUrl over the limit — both lines below fail.
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    // And the no-options call is byte-identical to an explicit web request:
    const explicit = prepareMaintenanceEmail(REALISTIC_LONG, { transport: 'outlook-web' });
    expect(explicit.draft.body).toBe(prepared.draft.body);
    expect(explicit.outlookUrl).toBe(prepared.outlookUrl);
    expect(explicit.transport).toBe('outlook-web');
  });

  it('THE FIX: a declared native transport is fitted against the NATIVE url — forcing the fit back onto the web url fails this test', () => {
    const web = prepareMaintenanceEmail(REALISTIC_LONG);
    const native = prepareMaintenanceEmail(REALISTIC_LONG, { transport: 'outlook-native' });

    // The defect this option closes, stated as the difference it makes: the
    // same input condenses under the web budget and rides WHOLE under the
    // native one. An implementation that measured outlookUrl despite the
    // declared native transport would condense here too.
    expect(web.draft.condensed).toBe(true);
    expect(native.draft.condensed).toBe(false);
    expect(native.linkFits).toBe(true);
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(native.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);

    // What the phone recovers, named: the FULL description (the web budget
    // truncates it at the 400-char word boundary)...
    expect(native.draft.body).toContain(REALISTIC_LONG.description);
    expect(web.draft.body).not.toContain(REALISTIC_LONG.description);
    // ...and the blocks the condensed shape drops entirely.
    for (const line of [
      'Category: Heating or air conditioning',
      'Priority: High',
      'Email: jane.smith@learn4life.org',
      'Building: Main Building',
    ]) {
      expect(native.draft.body).toContain(line);
      expect(web.draft.body).not.toContain(line);
    }
  });

  it('THE HEADROOM the old behaviour threw away, in characters', () => {
    const web = prepareMaintenanceEmail(REALISTIC_LONG);
    // The url the phone actually opens, under the old web-only fit, sat
    // hundreds of characters short of the ceiling while real content was
    // being dropped. (Relationship assertion, not an exact byte count —
    // the exact figure was 567 when measured under node 2026-08-16.)
    const wasted = DRAFT_URL_LIMIT - web.outlookMobileUrl.length;
    expect(wasted).toBeGreaterThan(400);
    // The native fit claims that headroom without exceeding the limit.
    const native = prepareMaintenanceEmail(REALISTIC_LONG, { transport: 'outlook-native' });
    expect(native.outlookMobileUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(DRAFT_URL_LIMIT - native.outlookMobileUrl.length).toBeLessThan(wasted);
    expect(native.draft.body.length).toBeGreaterThan(web.draft.body.length);
  });

  it('under the native budget the WEB url is genuinely unmeasured — which is why the default is web', () => {
    // The teeth behind the stamp: a caller that declared native and then
    // opened outlookUrl anyway would hand the OS a url past the limit with
    // linkFits still true. The mobile opener follows `transport` to make
    // that structurally impossible.
    const native = prepareMaintenanceEmail(REALISTIC_LONG, { transport: 'outlook-native' });
    expect(native.linkFits).toBe(true);
    expect(native.outlookUrl.length).toBeGreaterThan(DRAFT_URL_LIMIT);
  });

  it('the prepared email records which transport it was fitted for', () => {
    expect(prepareMaintenanceEmail(MODERATE_INPUT).transport).toBe('outlook-web');
    expect(prepareMaintenanceEmail(MODERATE_INPUT, { transport: 'outlook-web' }).transport).toBe('outlook-web');
    expect(prepareMaintenanceEmail(MODERATE_INPUT, { transport: 'outlook-native' }).transport).toBe('outlook-native');
  });

  it('a draft that fits WHOLE is unaffected by the transport — same bytes either way', () => {
    const web = prepareMaintenanceEmail(MODERATE_INPUT);
    const native = prepareMaintenanceEmail(MODERATE_INPUT, { transport: 'outlook-native' });
    expect(web.draft.condensed).toBe(false);
    expect(native.draft.condensed).toBe(false);
    expect(native.draft.body).toBe(web.draft.body);
    expect(native.outlookUrl).toBe(web.outlookUrl);
    expect(native.outlookMobileUrl).toBe(web.outlookMobileUrl);
    expect(native.mailtoUrl).toBe(web.mailtoUrl);
    expect(native.clipboardText).toBe(web.clipboardText);
  });

  it('the oversized floor is still reachable on the native budget: nothing may be opened when even the condensed pair overflows', () => {
    const pathological = {
      ...FULL_INPUT,
      description: 'Detail line. '.repeat(400),
      requesterName: 'X'.repeat(2000),
    };
    const native = prepareMaintenanceEmail(pathological, { transport: 'outlook-native' });
    expect(native.linkFits).toBe(false);
    expect(native.transport).toBe('outlook-native');
  });

  it('the mandatory CC survives the native-fitted draft on every transport it could open', () => {
    const native = prepareMaintenanceEmail(REALISTIC_LONG, { transport: 'outlook-native' });
    expect(decodeMobileCompose(native.outlookMobileUrl).cc).toBe('arosas@cvwest.org');
    expect(native.mailtoUrl.startsWith('mailto:dc4@learn4life.org?cc=arosas%40cvwest.org')).toBe(true);
    expect(decodeCompose(native.outlookUrl).params.cc).toBe('Andrew Rosas <arosas@cvwest.org>');
    expect(native.clipboardText).toContain('CC: arosas@cvwest.org');
  });
});

describe('the mailto is strictly inside whichever compose url was measured', () => {
  // WHY THIS EXISTS — an equivalent-mutant finding, made explicit rather than
  // left as folklore. The fit decision checks `mailtoUrl.length` alongside the
  // declared transport's compose url, but for this body shape that term NEVER
  // BINDS: the web url double-encodes the body (a space costs 6 chars), and
  // the native url carries more base overhead than `mailto:` plus a path
  // address, so the mailto is strictly the shortest of the three on every
  // rung. Deleting the term from the fit changes no observable output today —
  // a mutation run proved it survives both full suites.
  //
  // The cc-untrusted reroute (NATIVE_OUTLOOK_CC_TRUSTED -> mailto) is
  // therefore safe because of THIS measured inequality, not because of the
  // decorative term. This test is the load-bearing pin: if a future body or
  // transport shape ever makes the mailto the longest url, the inequality
  // breaks HERE, loudly, and the belt-and-braces term in `measure()` starts
  // to matter — see the comment on the fit line in email.ts.
  const CASES: Array<[string, MaintenanceEmailInput]> = [
    ['full', FULL_INPUT],
    ['minimal', MINIMAL_INPUT],
    ['moderate', MODERATE_INPUT],
  ];

  for (const [name, input] of CASES) {
    for (const transport of ['outlook-web', 'outlook-native'] as const) {
      it(`${name} / ${transport}: mailto < the measured compose url, on the CHOSEN rung`, () => {
        const p = prepareMaintenanceEmail(input, { transport });
        const measured = transport === 'outlook-native' ? p.outlookMobileUrl : p.outlookUrl;
        expect(p.mailtoUrl.length).toBeLessThan(measured.length);
      });
    }
  }

  it('holds on the condensed rung too, where the margin is tightest', () => {
    // The realistic long description condenses under the web budget — the
    // inequality must survive the rung the ladder actually lands on, not just
    // the roomy full drafts above.
    const long: MaintenanceEmailInput = {
      ...FULL_INPUT,
      description: 'The HVAC unit in the west wing has been intermittently failing. '.repeat(12),
    };
    for (const transport of ['outlook-web', 'outlook-native'] as const) {
      const p = prepareMaintenanceEmail(long, { transport });
      const measured = transport === 'outlook-native' ? p.outlookMobileUrl : p.outlookUrl;
      expect(p.mailtoUrl.length).toBeLessThan(measured.length);
      // And the consequence the reroute relies on: whenever the chosen rung
      // fits its declared transport, the mailto fits too.
      if (p.linkFits) expect(p.mailtoUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    }
  });
});

describe('per-org recipients — the builder composes with what it is HANDED', () => {
  // Factory-passing but deliberately unresolvable (.invalid is RFC 2606
  // reserved): these tests prove the recipients travel end to end without
  // ever composing against a real mailbox.
  const OTHER = maintenanceEmailRecipients({
    to: 'intake@other-tenant.invalid',
    cc: 'copy@other-tenant.invalid',
    toName: 'Other Intake',
    ccName: 'Other Copy',
  });

  it('MUTATION PROOF: flipping the cc changes the draft, the composed URLs and nothing else', () => {
    const base = prepareMaintenanceEmail(FULL_INPUT);
    const flipped = prepareMaintenanceEmail({
      ...FULL_INPUT,
      recipients: maintenanceEmailRecipients({
        to: L4L_MAINTENANCE_RECIPIENTS.to,
        cc: 'copy@other-tenant.invalid',
        toName: L4L_MAINTENANCE_RECIPIENTS.toName,
        ccName: L4L_MAINTENANCE_RECIPIENTS.ccName,
      }),
    });
    // The cc follows the input — a builder still reading the constant would
    // return 'arosas@cvwest.org' here and this kills that mutant.
    expect(base.draft.cc).toBe('arosas@cvwest.org');
    expect(flipped.draft.cc).toBe('copy@other-tenant.invalid');
    // Every transport carries the flipped cc; none carries the constant one.
    expect(flipped.outlookUrl).toContain(encodeURIComponent(encodeURIComponent('copy@other-tenant.invalid')));
    expect(flipped.outlookUrl).not.toContain(encodeURIComponent(encodeURIComponent('arosas@cvwest.org')));
    expect(flipped.mailtoUrl).toContain('copy%40other-tenant.invalid');
    expect(flipped.mailtoUrl).not.toContain('arosas');
    expect(flipped.clipboardText).toContain('copy@other-tenant.invalid');
    expect(flipped.clipboardText).not.toContain('arosas@cvwest.org');
    // The body is recipient-independent — only the routing moved.
    expect(flipped.draft.body).toBe(base.draft.body);
    expect(flipped.draft.subject).toBe(base.draft.subject);
  });

  it('display names ride the draft and reach ONLY the OWA chip slots', () => {
    const p = prepareMaintenanceEmail({ ...MINIMAL_INPUT, recipients: OTHER });
    expect(p.draft.toName).toBe('Other Intake');
    expect(p.draft.ccName).toBe('Other Copy');
    const { to } = decodeCompose(p.outlookUrl);
    expect(to).toBe('Other Intake <intake@other-tenant.invalid>');
    // The native and mailto transports stay bare-address (the OWA boundary).
    expect(p.outlookMobileUrl).not.toContain(encodeURIComponent('Other Intake'));
    expect(p.mailtoUrl).not.toContain(encodeURIComponent('Other Intake'));
  });

  it('a recipients value without names composes chip-less, not with L4L names', () => {
    const bare = maintenanceEmailRecipients({
      to: 'intake@other-tenant.invalid',
      cc: 'copy@other-tenant.invalid',
    });
    const p = prepareMaintenanceEmail({ ...MINIMAL_INPUT, recipients: bare });
    expect(p.draft.toName).toBeUndefined();
    const { to } = decodeCompose(p.outlookUrl);
    // A builder that still read L4L_MAINTENANCE_EMAIL_NAMES would produce
    // 'Fresno Warehouse DC4 <...>' here.
    expect(to).toBe('intake@other-tenant.invalid');
    expect(p.outlookUrl).not.toContain(encodeURIComponent(encodeURIComponent('Fresno Warehouse DC4')));
  });

  it('a malformed recipients value smuggled past the brand throws at draft time', () => {
    const poisoned = {
      to: 'a?cc=attacker@evil.test',
      cc: 'copy@other-tenant.invalid',
    } as unknown as MaintenanceEmailInput['recipients'];
    expect(() => buildMaintenanceEmailDraft({ ...MINIMAL_INPUT, recipients: poisoned })).toThrow(
      /must be exactly one plain email address/,
    );
  });
});
