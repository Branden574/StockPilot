import 'server-only';

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

import { claudeGenerateJsonString } from '@/lib/ai/claude';
import { resolveAiProvider } from '@/lib/ai/provider';
import { dropDuplicateNewIsbnLines } from '@/lib/po-scan/dedupe';
import { env } from '@/lib/env';

/**
 * Strict JSON schema we hand to Gemini's structured-output mode. Every
 * field has an explicit type so the model can't drift into freeform
 * shapes; numerics come back as numbers, not strings.
 *
 * If the schema changes here, update the corresponding zod parse on the
 * server route side too — they're paired.
 */
const PO_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    poNumber: {
      type: SchemaType.STRING,
      description:
        'The vendor-assigned PO number, order number, or invoice number. May appear as "PO #", "Order Number", "Invoice", etc. Empty string if not present.',
    },
    vendorName: {
      type: SchemaType.STRING,
      description:
        'The supplier / vendor / seller printing the PO — usually the company at the top of the document. Not the buyer. Empty string if unclear.',
    },
    vendorAddress: {
      type: SchemaType.STRING,
      description: 'Vendor mailing address as a single line. Empty string if not present.',
    },
    orderDate: {
      type: SchemaType.STRING,
      description:
        'Order or PO date in YYYY-MM-DD when possible, otherwise the raw string from the document. Empty string if not present.',
    },
    expectedDate: {
      type: SchemaType.STRING,
      description:
        'Expected delivery / ship date if printed. YYYY-MM-DD preferred. Empty string if not present.',
    },
    subtotal: {
      type: SchemaType.NUMBER,
      description: 'Subtotal in dollars (number, not string). 0 if not present.',
    },
    tax: { type: SchemaType.NUMBER, description: 'Tax in dollars. 0 if not present.' },
    freight: {
      type: SchemaType.NUMBER,
      description: 'Shipping / freight charges in dollars. 0 if not present.',
    },
    grandTotal: {
      type: SchemaType.NUMBER,
      description: 'Grand total in dollars. 0 if not present.',
    },
    overallConfidence: {
      type: SchemaType.NUMBER,
      description:
        'Your confidence (0.0 to 1.0) that the OVERALL extraction is correct. Reduce when the image is blurry, low-contrast, partially cut off, or in an unusual layout.',
    },
    lines: {
      type: SchemaType.ARRAY,
      description:
        'EVERY item row in the document — one entry per printed product/asset/device/service row, in order. Include price-less rows (packing slips list quantity with no price — still include them, price 0). Do NOT merge a product row with a separate service/fee row. Exclude only header rows and the "Subtotal:"/"Tax:"/"Total:" summary rows (a tax/freight/fee that is its own item ROW still belongs here with the matching lineType).',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          lineNumber: {
            type: SchemaType.NUMBER,
            description: '1-indexed sequence in the order printed on the document.',
          },
          description: {
            type: SchemaType.STRING,
            description:
              'The product description AS PRINTED. Preserve original wording; do not rephrase. If the description spans multiple lines on the page, join with a single space.',
          },
          vendorSku: {
            type: SchemaType.STRING,
            description:
              "The vendor's part number / item number / catalog number / SKU for this line. Often a short alphanumeric like 'B0G7GYW5YY' or '0328XXX'. Empty string if not present. Be careful with O vs 0, l vs 1, I vs 1.",
          },
          quantity: {
            type: SchemaType.NUMBER,
            description: 'Quantity ordered. 0 if illegible or not present.',
          },
          uom: {
            type: SchemaType.STRING,
            description: 'Unit of measure (EA, CS, BX, PK, etc.). Empty string if not present.',
          },
          unitPrice: {
            type: SchemaType.NUMBER,
            description: 'Unit price in dollars. 0 if not present.',
          },
          lineTotal: {
            type: SchemaType.NUMBER,
            description:
              'Line total / extended price in dollars. If only the unit price is shown, compute it as quantity * unitPrice. 0 if not deducible.',
          },
          lineType: {
            type: SchemaType.STRING,
            description:
              "One of: 'inventory' (a stockable product), 'tax', 'freight' (shipping), 'service', 'fee', 'discount'. Default to 'inventory' for normal product lines.",
          },
          confidence: {
            type: SchemaType.NUMBER,
            description:
              'Your confidence (0.0 to 1.0) that THIS LINE was extracted correctly. Reduce for: ambiguous SKU characters (O/0, l/1), partially obscured text, faded ink, hand-written numbers.',
          },
          // ── Sports variant fields (Task 13) ─────────────────────────────
          // All OPTIONAL (absent from `required` below): a non-sports PO
          // returns them empty and behaves exactly as it did before. Every
          // description tells the model to leave a field EMPTY rather than
          // guess — "missing stays missing".
          size: {
            type: SchemaType.STRING,
            description:
              'The size AS PRINTED for this line (e.g. "10", "10.5", "XL", "US 9"). Copy it exactly; do not convert between size systems. Empty string if the line has no size.',
          },
          sizeSystem: {
            type: SchemaType.STRING,
            description:
              "The size system if the document states one: 'US_MENS', 'US_WOMENS', 'US_YOUTH', 'UK', 'EU', 'CM', or 'ALPHA' for letter sizes. Empty string if the document does not say — do NOT guess.",
          },
          width: {
            type: SchemaType.STRING,
            description:
              'Shoe width if printed (N, M, W, 2E, 4E, Standard, Wide, Extra Wide). Empty string if not present.',
          },
          colorway: {
            type: SchemaType.STRING,
            description:
              'Colour or colourway as printed ("Black/White"). Empty string if not present.',
          },
          jerseyNumber: {
            type: SchemaType.STRING,
            description:
              'The UNIFORM/JERSEY number for this line, as text, KEEPING leading zeroes ("00", "07"). Only fill this when the document clearly labels it as a jersey/uniform/player number. A bare "Number" column is ambiguous — leave this empty and lower mappingConfidence instead. NEVER put a serial number or a quantity here.',
          },
          playerName: {
            type: SchemaType.STRING,
            description:
              'Player or wearer name if the line names one. Empty string if not present. Never invent a name.',
          },
          groupHint: {
            type: SchemaType.STRING,
            description:
              'The style/product identity this line belongs to, as printed ("Nike Pegasus 41 FD2722", "Falcons Home Jersey 2026"). This is what lets several size lines resolve to ONE product. Empty string if unclear.',
          },
          mappingConfidence: {
            type: SchemaType.NUMBER,
            description:
              'Your confidence (0.0-1.0) that you assigned each value to the RIGHT FIELD. Lower this sharply when a column header is ambiguous (a bare "Number" could be a jersey number, a quantity, a serial, a style number or a PO line number). This is separate from `confidence`, which is about reading the characters correctly.',
          },
        },
        required: [
          'lineNumber',
          'description',
          'quantity',
          'unitPrice',
          'lineTotal',
          'lineType',
          'confidence',
        ],
      },
    },
  },
  required: ['poNumber', 'vendorName', 'lines', 'overallConfidence'],
} as const;

const SYSTEM_PROMPT = `You extract structured line-item data from photos or PDFs of any goods document: purchase orders, invoices, order confirmations, packing slips, delivery notes, shipping manifests, and service / recycling / eWaste orders.

COMPLETENESS IS THE #1 GOAL — extract EVERY line item, not just the priced ones:
- Return one \`lines\` entry for EVERY distinct product, item, asset, device, or service row in the items table. Do not stop after the first row. Count the rows and make sure your output has the same number.
- NEVER merge two separate rows into one line. In particular, keep a PRODUCT/asset row (e.g. a device model like "Acer Chromebook 511 C737LT" with a quantity) SEPARATE from any service, handling, "white glove", or fee row — even when they sit next to each other or share a total. Each printed row is its own line.
- PRICES ARE OPTIONAL. Packing slips, delivery notes, and service/recycling orders routinely list items with a quantity and NO price. A missing price is normal: set unitPrice and lineTotal to 0 and STILL include the line. NEVER drop or skip an item row just because it has no dollar amount — quantity + description alone make a valid line.
- A product/asset row is \`lineType: 'inventory'\` even on a service or recycling document (the devices being processed are the inventory; the "white glove"/eWaste/handling charge is a separate 'service' or 'fee' line).

Other rules:
- Return ONLY the JSON matching the schema. No markdown, no explanation.
- For numeric fields, return numbers (e.g. 12.5), never strings.
- Preserve exact text in description and vendorSku — do not rephrase or normalize.
- Be careful with character ambiguity in SKUs: O vs 0, l vs 1 vs I, S vs 5, B vs 8.
- If a SINGLE line's description wraps to a second physical line on the page, join it into one description with a space — but do NOT combine two DIFFERENT item rows this way.
- Exclude only the totals rows from \`lines\` (Subtotal/Tax/Freight/Grand Total summary lines) — put those amounts in the top-level fields. A tax/freight/fee that appears as its own item ROW still goes in \`lines\` with the matching lineType.
- For each line, set \`confidence\` lower (0.6-0.8) when SKU characters are ambiguous, when ink is faded, or when fields are partially obscured. High confidence (0.9+) only when the row is crisp and unambiguous.
- Set \`overallConfidence\` lower when the image is skewed, low-resolution, or in an unusual layout.
- Return an empty \`lines\` array ONLY when the document genuinely lists no items at all (e.g. a random photo). A packing slip or price-less order is a valid document — extract its items.
- If multiple pages/frames are provided, treat them as one document and merge the lines (but still keep each printed row separate).

NEVER INVENT A VALUE:
Never invent a serial number, jersey number, size, quantity, SKU, team or
player. If a value is not printed on the document, return an empty string.
A missing value must stay missing. If a column header is ambiguous, leave the
specific field empty and lower mappingConfidence rather than guessing.`;

export interface ExtractedPo {
  poNumber: string;
  vendorName: string;
  vendorAddress: string;
  orderDate: string;
  expectedDate: string;
  subtotal: number;
  tax: number;
  freight: number;
  grandTotal: number;
  overallConfidence: number;
  lines: Array<{
    lineNumber: number;
    description: string;
    vendorSku: string;
    quantity: number;
    uom: string;
    unitPrice: number;
    lineTotal: number;
    lineType: 'inventory' | 'tax' | 'freight' | 'service' | 'fee' | 'discount' | 'unknown';
    confidence: number;
    // ── Sports variant fields (Task 13) ───────────────────────────────────
    // Always PRESENT after normalization, empty when the document said
    // nothing. Empty string is the "missing" value at this layer; the
    // po_import_lines mappers convert it to a real NULL.
    /** The size exactly as printed. Never converted between systems. */
    size: string;
    /** US_MENS | US_WOMENS | US_YOUTH | UK | EU | CM | ALPHA, or '' if the document did not say. */
    sizeSystem: string;
    width: string;
    colorway: string;
    /** TEXT, with leading zeroes intact. NEVER a number — 7 and 07 are different uniforms. */
    jerseyNumber: string;
    playerName: string;
    /** Free-text style/product identity used to resolve several size lines to ONE product. */
    groupHint: string;
    /** 0..1 confidence in the FIELD MAPPING (not the character reading). Null when the model gave none. */
    mappingConfidence: number | null;
  }>;
}

export interface ScanInput {
  /** Base64-encoded file content (no data: prefix). */
  base64: string;
  /** image/jpeg, image/png, image/webp, application/pdf */
  mimeType: string;
}

// Recorded in po_imports.extraction_model — reflect the model that ACTUALLY
// runs the scan for the active provider. Claude scans use the dedicated
// PO-scan escalation model (ANTHROPIC_PO_SCAN_MODEL, default claude-sonnet-5):
// verified 2026-07-13 that Haiku merges packing-slip rows into one line while
// Sonnet extracts every row (incl. a handwritten qty) from the same photo.
// Gemini fallback keeps GEMINI_MODEL.
export const SCAN_MODEL_NAME =
  resolveAiProvider() === 'claude' ? env.ANTHROPIC_PO_SCAN_MODEL : env.GEMINI_MODEL;

/**
 * Sends one or more images / a PDF to Gemini Flash and returns a parsed,
 * shape-validated PO. Pass multiple ScanInputs for multi-page or
 * multi-frame captures (the model will merge them into one logical PO).
 *
 * Throws when:
 *   • GEMINI_API_KEY is not configured
 *   • The model returns invalid JSON or a payload missing required fields
 *   • The model emits an empty `lines` array AND overallConfidence < 0.3
 *     (treat as "not a PO" — don't waste a po_imports row)
 */
export async function extractPoFromMedia(inputs: ScanInput[]): Promise<ExtractedPo> {
  if (inputs.length === 0) {
    throw new Error('No media provided to extract.');
  }

  const useClaude = resolveAiProvider() === 'claude';
  if (useClaude ? !env.ANTHROPIC_API_KEY : !env.GEMINI_API_KEY) {
    throw new Error(
      useClaude
        ? 'ANTHROPIC_API_KEY is not set. Add it to apps/web/.env.local + Vercel env.'
        : 'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey and add it to apps/web/.env.local.',
    );
  }

  let text: string;
  if (useClaude) {
    text = await claudeGenerateJsonString({
      system: SYSTEM_PROMPT,
      prompt: 'Extract EVERY line item from this document (it may be a purchase order, invoice, packing slip, delivery note, or service/recycling order). List each printed item row separately, including rows that have a quantity but no price.',
      media: inputs.map((i) => ({ data: i.base64, mediaType: i.mimeType })),
      schema: PO_SCHEMA as unknown as Record<string, unknown>,
      // Escalated scan model (see SCAN_MODEL_NAME). No `temperature`:
      // sonnet-5+ rejects the param, and the forced-tool + schema already
      // constrain the output.
      model: env.ANTHROPIC_PO_SCAN_MODEL,
      // Raised from 4096 with the Task 13 variant fields: each line now emits
      // eight more keys, so the SAME 40-line book PO that fit before would
      // otherwise truncate mid-JSON and surface as "AI returned non-JSON".
      // Output tokens are billed as generated, so the extra ceiling costs
      // nothing on the short documents that never approach it.
      maxTokens: 8192,
    });
  } else {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: SCAN_MODEL_NAME,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: 'application/json',

        responseSchema: PO_SCHEMA as any,
        temperature: 0.05,
      },
    });

    const parts = inputs.map((i) => ({
      inlineData: { data: i.base64, mimeType: i.mimeType },
    }));

    const result = await model.generateContent([
      ...parts,
      { text: 'Extract EVERY line item from this document (it may be a purchase order, invoice, packing slip, delivery note, or service/recycling order). List each printed item row separately, including rows that have a quantity but no price.' },
    ]);
    text = result.response.text();
  }

  let parsed: ExtractedPo;
  try {
    parsed = JSON.parse(text) as ExtractedPo;
  } catch (e) {
    throw new Error(
      `AI returned non-JSON: ${(e as Error).message}\nRaw: ${text.slice(0, 500)}`,
    );
  }

  // Defensive normalization: the model occasionally emits null where we
  // declared NUMBER. Coerce to defaults so downstream INSERTs don't blow up.
  parsed.poNumber = parsed.poNumber ?? '';
  parsed.vendorName = parsed.vendorName ?? '';
  parsed.vendorAddress = parsed.vendorAddress ?? '';
  parsed.orderDate = parsed.orderDate ?? '';
  parsed.expectedDate = parsed.expectedDate ?? '';
  parsed.subtotal = Number.isFinite(parsed.subtotal) ? parsed.subtotal : 0;
  parsed.tax = Number.isFinite(parsed.tax) ? parsed.tax : 0;
  parsed.freight = Number.isFinite(parsed.freight) ? parsed.freight : 0;
  parsed.grandTotal = Number.isFinite(parsed.grandTotal) ? parsed.grandTotal : 0;
  parsed.overallConfidence = Number.isFinite(parsed.overallConfidence)
    ? Math.max(0, Math.min(1, parsed.overallConfidence))
    : 0;
  parsed.lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  parsed.lines = parsed.lines.map((l, i) => ({
    lineNumber: Number.isFinite(l.lineNumber) ? l.lineNumber : i + 1,
    description: l.description ?? '',
    vendorSku: l.vendorSku ?? '',
    quantity: Number.isFinite(l.quantity) ? l.quantity : 0,
    uom: l.uom ?? '',
    unitPrice: Number.isFinite(l.unitPrice) ? l.unitPrice : 0,
    lineTotal: Number.isFinite(l.lineTotal)
      ? l.lineTotal
      : (Number.isFinite(l.quantity) ? l.quantity : 0) *
        (Number.isFinite(l.unitPrice) ? l.unitPrice : 0),
    lineType: ((['inventory', 'tax', 'freight', 'service', 'fee', 'discount'] as const).includes(
      l.lineType as never,
    )
      ? l.lineType
      : 'inventory') as ExtractedPo['lines'][number]['lineType'],
    confidence: Number.isFinite(l.confidence) ? Math.max(0, Math.min(1, l.confidence)) : 0.5,
    // ── Sports variant fields (Task 13) ───────────────────────────────────
    // This mapper rebuilds each line from a WHITELIST, so a field missing
    // here is silently dropped however well the model extracted it.
    //
    // The `typeof === 'string'` guards are load-bearing, not defensive
    // noise: a model that returns 7 for jerseyNumber must lose the value
    // rather than have it stringified into a WRONG one ("7" is not "07").
    size: typeof l.size === 'string' ? l.size.trim() : '',
    sizeSystem: typeof l.sizeSystem === 'string' ? l.sizeSystem.trim().toUpperCase() : '',
    width: typeof l.width === 'string' ? l.width.trim() : '',
    colorway: typeof l.colorway === 'string' ? l.colorway.trim() : '',
    // Keep leading zeroes: never Number() this value.
    jerseyNumber: typeof l.jerseyNumber === 'string' ? l.jerseyNumber.trim() : '',
    playerName: typeof l.playerName === 'string' ? l.playerName.trim() : '',
    groupHint: typeof l.groupHint === 'string' ? l.groupHint.trim() : '',
    mappingConfidence:
      typeof l.mappingConfidence === 'number' && Number.isFinite(l.mappingConfidence)
        ? Math.min(1, Math.max(0, l.mappingConfidence))
        : null,
  }));

  if (parsed.lines.length === 0 && parsed.overallConfidence < 0.3) {
    throw new Error(
      "This doesn't look like a purchase order — try a clearer photo of the full document.",
    );
  }

  // Collapse the "priced title row + (NEW)/ISBN $0 row" duplicates some vendor
  // PDFs print for each product (see dropDuplicateNewIsbnLines).
  parsed.lines = dropDuplicateNewIsbnLines(parsed.lines);

  return parsed;
}
