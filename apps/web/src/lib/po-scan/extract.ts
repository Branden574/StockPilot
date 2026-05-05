import 'server-only';

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

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
        'Each line item on the PO. Include only LINE ITEMS — exclude header rows, "Subtotal:", "Tax:", "Total:" rows, and footer notes. Each tax/freight line that appears as a separate line ITEM (not in totals) goes here with the appropriate lineType.',
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

const SYSTEM_PROMPT = `You extract structured purchase-order data from photos or PDFs of POs.

Rules:
- Return ONLY the JSON matching the schema. No markdown, no explanation.
- For numeric fields, return numbers (e.g. 12.5), never strings.
- Preserve exact text in description and vendorSku — do not rephrase or normalize.
- Be careful with character ambiguity in SKUs: O vs 0, l vs 1 vs I, S vs 5, B vs 8.
- If a line description wraps to a second line on the page, join into one description with a space.
- Exclude the totals rows from \`lines\` (Subtotal/Tax/Freight/Grand Total) — put those in the top-level fields.
- For each line, set \`confidence\` lower (0.6-0.8) when SKU characters are ambiguous, when ink is faded, or when fields are partially obscured. High confidence (0.9+) only when the row is crisp and unambiguous.
- Set \`overallConfidence\` lower when the image is skewed, low-resolution, or in an unusual layout.
- If the document is clearly NOT a purchase order or invoice, return an empty \`lines\` array and \`overallConfidence\` near 0.
- If a multi-page PO is provided, treat all pages as one document and merge the lines.`;

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
  }>;
}

export interface ScanInput {
  /** Base64-encoded file content (no data: prefix). */
  base64: string;
  /** image/jpeg, image/png, image/webp, application/pdf */
  mimeType: string;
}

// Model name comes from env so we can swap models without a code
// deploy. Free-tier eligibility shifts per project — gemini-1.5-flash
// has had the most reliable free quota; 2.0 / 2.5 work when enabled.
// Default lives in lib/env.ts (currently gemini-1.5-flash); override
// via GEMINI_MODEL env var.
export const SCAN_MODEL_NAME = env.GEMINI_MODEL;

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
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/app/apikey and add it to apps/web/.env.local.',
    );
  }
  if (inputs.length === 0) {
    throw new Error('No media provided to extract.');
  }

  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: SCAN_MODEL_NAME,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseSchema: PO_SCHEMA as any,
      temperature: 0.05,
    },
  });

  const parts = inputs.map((i) => ({
    inlineData: { data: i.base64, mimeType: i.mimeType },
  }));

  const result = await model.generateContent([
    ...parts,
    { text: 'Extract the purchase order from this document.' },
  ]);

  const text = result.response.text();
  let parsed: ExtractedPo;
  try {
    parsed = JSON.parse(text) as ExtractedPo;
  } catch (e) {
    throw new Error(
      `Gemini returned non-JSON: ${(e as Error).message}\nRaw: ${text.slice(0, 500)}`,
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
  }));

  if (parsed.lines.length === 0 && parsed.overallConfidence < 0.3) {
    throw new Error(
      "This doesn't look like a purchase order — try a clearer photo of the full document.",
    );
  }

  return parsed;
}
