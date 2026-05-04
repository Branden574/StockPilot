import type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
import { classifyLine } from './classify';
import { normalizeUom, parseMoney, parseQty } from './normalize';

/**
 * Header regexes — robust to extra whitespace / case variations.
 */
const PO_NUMBER_RE = /\bPO\s*Number\s*:?\s*(PO-[A-Z0-9-]{4,})/i;
const PO_NUMBER_FALLBACK_RE = /\b(PO-[A-Z]{2,}-?\d{3,})/;
const TOTAL_RE = /\bTotal[:\s]+\$?\s*([0-9,]+\.\d{2})/i;
const VENDOR_HEADER_RE = /^\s*(Staples\s+Advantage|Vendor:\s*([^\n]+))/im;
const SHIPPING_RE = /Shipping\s*Address[:\s]+([^\n]+)/i;
const CONTACT_RE = /\bContact[:\s]+([^\n]+)/i;
const PHONE_RE = /\bPhone[:\s]+([^\n]+)/i;
const DATE_RE = /^\s*Date\s*:\s*([0-9/.-]+)/im;
const DESCRIPTION_HEADER_RE = /^\s*Description\s*:\s*([^\n]+)/im;
const PREPARED_BY_RE = /\bPrepared\s*By\s*:\s*([^\n]+)/i;
const WORKFLOW_RE = /\bWorkflow\s*:\s*([^\n]+)/i;
const REASON_RE = /\bReason\s*:\s*([^\n]+)/i;
const COMMENTS_RE = /\bComments\s*:\s*([^\n]+)/i;

/**
 * A line begins with: "<qty> <UOM> <date?> <description...>" and ends with
 * two trailing money columns: "<unit_cost> <total>". UOM is 2-4 uppercase
 * letters. The date is optional (some POs have it on a continuation row).
 *
 * Followed (sometimes on the next line) by: "Item Number: <n>   Vendor
 * Product No: <n>   Auxiliary No: <n>   COA #: <code>".
 */
const LINE_HEAD_RE =
  /^\s*(?<qty>\d+(?:\.\d+)?)\s+(?<uom>[A-Z]{2,4})\s+(?<rest>.+?)$/;
const ITEM_NUM_RE = /Item\s*Number[:\s]+(?<num>[A-Z0-9-]+)/i;
const VENDOR_PRODUCT_RE = /Vendor\s*Product\s*No[.:\s]+(?<num>[A-Z0-9-]+)/i;
const AUX_NUM_RE = /Auxiliary\s*No[.:\s]+(?<num>[A-Z0-9-]+)/i;
const COA_RE = /COA\s*#?[:\s]+(?<code>[A-Z0-9-]+)/i;
const TRAIL_MONEY_RE =
  /(?<unit>\(?\$?\s*-?\d[\d,]*\.\d{2}\)?)\s+(?<total>\(?\$?\s*-?\d[\d,]*\.\d{2}\)?)\s*$/;

function pickFirst(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

export function parsePdfText(rawText: string): CanonicalPo {
  const lines = rawText.split(/\r?\n/);

  // Header extraction
  const poNumberMatch =
    rawText.match(PO_NUMBER_RE)?.[1] ?? rawText.match(PO_NUMBER_FALLBACK_RE)?.[1] ?? null;
  const totalAmount = parseMoney(rawText.match(TOTAL_RE)?.[1] ?? null);
  const vendorMatch = rawText.match(VENDOR_HEADER_RE);
  const vendorName = vendorMatch
    ? pickFirst(vendorMatch[2] ?? vendorMatch[1])
    : null;
  const shippingAddress = pickFirst(rawText.match(SHIPPING_RE)?.[1]);
  const contactName = pickFirst(rawText.match(CONTACT_RE)?.[1]);
  const contactPhone = pickFirst(rawText.match(PHONE_RE)?.[1]);
  const poDate = pickFirst(rawText.match(DATE_RE)?.[1]);
  const description = pickFirst(rawText.match(DESCRIPTION_HEADER_RE)?.[1]);
  const preparedBy = pickFirst(rawText.match(PREPARED_BY_RE)?.[1]);
  const workflow = pickFirst(rawText.match(WORKFLOW_RE)?.[1]);
  const reason = pickFirst(rawText.match(REASON_RE)?.[1]);
  const comments = pickFirst(rawText.match(COMMENTS_RE)?.[1]);

  // Lines
  const out: CanonicalPoLine[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i];
    if (!head) continue;
    const m = head.match(LINE_HEAD_RE);
    if (!m?.groups) continue;
    // Skip header rows that look like "1 EA TAX" but actually are real data.
    // The discriminator is: real lines have two trailing money columns.
    let rest = m.groups.rest ?? '';
    const trail = rest.match(TRAIL_MONEY_RE);
    if (!trail?.groups) continue;

    const qty = parseQty(m.groups.qty);
    const uom = normalizeUom(m.groups.uom);
    const unitCost = parseMoney(trail.groups.unit);
    const lineTotal = parseMoney(trail.groups.total);
    rest = rest.slice(0, trail.index!).trim();

    // Strip optional leading date from rest (MM/DD/YYYY).
    const desc = rest.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '').trim() || null;

    // Look at the next 2 lines for metadata (Item Number / Vendor Product No / etc.)
    const peek = `${lines[i + 1] ?? ''} ${lines[i + 2] ?? ''}`;
    const vendorItemNumber = peek.match(ITEM_NUM_RE)?.groups?.num ?? null;
    const vendorProductNumber = peek.match(VENDOR_PRODUCT_RE)?.groups?.num ?? null;
    const auxiliaryNumber = peek.match(AUX_NUM_RE)?.groups?.num ?? null;
    const coaCode = peek.match(COA_RE)?.groups?.code ?? null;

    out.push({
      lineNumber: ++n,
      lineType: classifyLine(desc, { signedAmount: lineTotal ?? undefined }),
      qtyOrderedOriginal: qty,
      uomOriginal: uom,
      description: desc,
      unitCost,
      lineTotal,
      vendorItemNumber,
      vendorProductNumber,
      auxiliaryNumber,
      coaCode,
    });
  }

  return {
    poNumber: poNumberMatch,
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
 * Streaming entry: takes a Buffer (the uploaded PDF) and returns a CanonicalPo.
 * Imports pdf-parse lazily so this file stays test-friendly with just the
 * text fixture in unit tests.
 */
export async function parsePdf(buffer: Buffer): Promise<CanonicalPo> {
  const mod = (await import('pdf-parse')) as unknown as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const { text } = await mod.default(buffer);
  return parsePdfText(text);
}
