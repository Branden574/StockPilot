import type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
import { classifyLine } from './classify';
import { normalizeUom, parseMoney, parseQty } from './normalize';

// Header capture: tolerant to colon, no-colon, value-on-next-line.
const PO_NUMBER_RE = /\b(PO-[A-Z]{2,}-?\d{3,})/i;
const TOTAL_RE = /\bTOTAL[\s\n]+\$?\s*([0-9,]+\.\d{2})/i;
const VENDOR_HEADER_RE = /(Staples\s+Advantage|Vendor:\s*([^\n]+))/i;
const SHIPPING_HEADER_RE = /SHIPPING\s+INFORMATION\s*\n((?:[^\n]+\n){1,4})/i;
const CONTACT_RE = /\bContact:\s*([^\n]+)/i;
const PHONE_RE = /\bPhone:\s*([^\n]+?)(?:\s+Contact:|\s*$)/im;

const HEADER_RES = {
  date: /^\s*DATE\s*:?\s*([0-9/.-]+)\s*$/im,
  description: /^\s*DESCRIPTION\s*:?\s*(.+?)\s*$/im,
  preparedBy: /^\s*PREPARED\s*BY\s*:?\s*([^\n]*)/im,
  workflow: /^\s*WORKFLOW\s*:?\s*(.+?)\s*$/im,
  reason: /^\s*Reason\s*:?\s*(.+?)\s*$/im,
  comments: /^\s*Comments\s*:?\s*(.+?)\s*$/im,
} as const;

// Line item start: "<qty><UOM><MM/DD/YYYY>" — concatenated with no spaces
// in real pdf-parse output (e.g. "1PK4/29/2026Duracell..."). The /g flag
// is for global scanning; we reset lastIndex before each call.
const LINE_START_RE =
  /(?<qty>\d+(?:\.\d+)?)(?<uom>[A-Z]{2,4})(?<date>\d{1,2}\/\d{1,2}\/\d{4})/g;

// Trailing price pair "23.11$23.11" or "23.11 $23.11". The $ between the
// two amounts is the only separator in the concatenated layout.
const TRAIL_PRICE_PAIR_RE =
  /\$?([0-9,]+\.\d{2})\s*\$?([0-9,]+\.\d{2})\s*$/;

const ITEM_NUM_RE = /Item\s*Number\s*:?\s*([A-Z0-9-]+)/i;
const VENDOR_PRODUCT_RE = /Vendor\s*Product\s*No\.?\s*:?\s*([A-Z0-9-]+)/i;
// Accept the common Staples typo "Auxilary" alongside "Auxiliary".
const AUX_NUM_RE = /Auxil(?:i)?ary\s*No\.?\s*:?\s*([A-Z0-9-]+)/i;
const COA_RE = /COA\s*#?\s*:?\s*([A-Z0-9-]+)/i;

function pickFirst(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function extractHeaderValue(
  text: string,
  key: keyof typeof HEADER_RES,
): string | null {
  const re = HEADER_RES[key];
  const m = text.match(re);
  if (!m) return null;
  // Some labels (PREPARED BY) put the value on the next text line because
  // the label sits in a table cell. If the captured group is empty or
  // looks like another label, peek the next non-empty line.
  const v = pickFirst(m[1]);
  if (v && !/^[A-Z\s]+$/.test(v)) return v;
  const after = text.slice((m.index ?? 0) + m[0].length);
  const next = after.split(/\r?\n/).find((l) => l.trim().length > 0);
  return pickFirst(next ?? null) ?? v;
}

interface LineHead {
  qty: string;
  uom: string;
  index: number; // start of <qty>
  endIndex: number; // just after <date>
}

function findLineHeads(text: string): LineHead[] {
  const heads: LineHead[] = [];
  LINE_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE_START_RE.exec(text))) {
    if (!m.groups) continue;
    // Reject if <qty> is preceded by a digit — that means we're in the
    // middle of a longer number (e.g. ZIP 75266-0409 or item number).
    const prev = text[m.index - 1];
    if (prev && /[0-9]/.test(prev)) continue;
    heads.push({
      qty: m.groups.qty!,
      uom: m.groups.uom!,
      index: m.index,
      endIndex: m.index + m[0].length,
    });
  }
  return heads;
}

export function parsePdfText(rawText: string): CanonicalPo {
  const poNumber = pickFirst(rawText.match(PO_NUMBER_RE)?.[1]);
  const totalAmount = parseMoney(rawText.match(TOTAL_RE)?.[1] ?? null);
  const vendorMatch = rawText.match(VENDOR_HEADER_RE);
  const vendorName = vendorMatch
    ? pickFirst(vendorMatch[2] ?? vendorMatch[1])
    : null;
  const shippingBlock = rawText.match(SHIPPING_HEADER_RE)?.[1] ?? null;
  const shippingAddress = shippingBlock
    ? pickFirst(
        shippingBlock
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^Phone:/i.test(l) && !/^Contact:/i.test(l))
          .join(', '),
      )
    : null;
  const contactName = pickFirst(rawText.match(CONTACT_RE)?.[1]);
  const contactPhone = pickFirst(rawText.match(PHONE_RE)?.[1]);
  const poDate = extractHeaderValue(rawText, 'date');
  const description = extractHeaderValue(rawText, 'description');
  const preparedBy = extractHeaderValue(rawText, 'preparedBy');
  const workflow = extractHeaderValue(rawText, 'workflow');
  const reason = extractHeaderValue(rawText, 'reason');
  const comments = extractHeaderValue(rawText, 'comments');

  // Find every line-item head and slice the body up to either the next
  // head or the next "Item Number" / "TOTAL" sentinel.
  const heads = findLineHeads(rawText);
  const out: CanonicalPoLine[] = [];

  for (let i = 0; i < heads.length; i++) {
    const head = heads[i]!;
    const next = heads[i + 1];

    let chunkEnd = next ? next.index : rawText.length;
    const itemNumberIdx = rawText.indexOf('Item Number', head.endIndex);
    if (itemNumberIdx !== -1 && itemNumberIdx < chunkEnd) {
      chunkEnd = itemNumberIdx;
    }
    const totalIdx = rawText.search(/\bTOTAL\b/);
    if (totalIdx > head.endIndex && totalIdx < chunkEnd) {
      chunkEnd = totalIdx;
    }

    const chunk = rawText.slice(head.endIndex, chunkEnd).trim();
    // Wrapped descriptions span multiple text lines. Flatten and collapse
    // whitespace so the trailing-price regex can find the prices wherever
    // they ended up.
    const flat = chunk.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    const trail = flat.match(TRAIL_PRICE_PAIR_RE);
    if (!trail) continue;
    const unitCost = parseMoney(trail[1]!);
    const lineTotal = parseMoney(trail[2]!);
    const desc = pickFirst(flat.slice(0, flat.length - trail[0].length).trim());

    // Vendor metadata sits in the few lines after the chunk.
    const tail = rawText
      .slice(chunkEnd)
      .split(/\r?\n/)
      .slice(0, 6)
      .join(' ');
    const vendorItemRaw = tail.match(ITEM_NUM_RE)?.[1] ?? null;
    const vendorProductRaw = tail.match(VENDOR_PRODUCT_RE)?.[1] ?? null;
    const auxRaw = tail.match(AUX_NUM_RE)?.[1] ?? null;
    const coaCode = tail.match(COA_RE)?.[1] ?? null;

    out.push({
      lineNumber: out.length + 1,
      lineType: classifyLine(desc, { signedAmount: lineTotal ?? undefined }),
      qtyOrderedOriginal: parseQty(head.qty),
      uomOriginal: normalizeUom(head.uom),
      description: desc,
      unitCost,
      lineTotal,
      vendorItemNumber: vendorItemRaw === 'N/A' ? null : vendorItemRaw,
      vendorProductNumber: vendorProductRaw === 'N/A' ? null : vendorProductRaw,
      auxiliaryNumber: auxRaw === 'N/A' ? null : auxRaw,
      coaCode,
    });
  }

  return {
    poNumber,
    vendorName,
    poDate,
    description,
    preparedBy,
    workflow,
    reason,
    comments,
    shippingAddress,
    contactName,
    contactPhone,
    totalAmount,
    lines: out,
  };
}

/**
 * Streaming entry: returns the parsed CanonicalPo plus the raw extracted
 * text. Caller persists raw_text so the UI can surface it for debugging
 * when the parser yields zero lines.
 */
export async function parsePdf(
  buffer: Buffer,
): Promise<CanonicalPo & { rawText: string }> {
  const mod = (await import('pdf-parse')) as unknown as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const { text } = await mod.default(buffer);
  return { ...parsePdfText(text), rawText: text };
}
