import Papa from 'papaparse';
import type { CanonicalPo, CanonicalPoLine } from '@stockpilot/core';
import { classifyLine } from './classify';
import { normalizeUom, parseMoney, parseQty } from './normalize';

type RawLineKey =
  | 'line_number'
  | 'qty'
  | 'uom'
  | 'description'
  | 'unit_cost'
  | 'line_total'
  | 'vendor_item_number'
  | 'vendor_product_number'
  | 'auxiliary_number'
  | 'coa_code';

/**
 * Parses a CSV in this two-block layout:
 *
 *   po_number,vendor,po_date,total
 *   PO-XXX,Acme,2026-04-29,299.53
 *
 *   line_number,qty,uom,description,unit_cost,line_total,vendor_item_number,...
 *   1,1,EA,TAX,23.11,23.11,,,,
 *   2,1,PK,"Duracell ...",16.67,16.67,867474,867474,867474,62-00
 */
export function parseCsvText(input: string): CanonicalPo {
  const all = Papa.parse<string[]>(input, { skipEmptyLines: true }).data;

  const headerRowIdx = all.findIndex((r) => r.includes('po_number'));
  const lineHeaderIdx = all.findIndex((r) => r.includes('line_number'));

  let poNumber: string | null = null;
  let vendorName: string | null = null;
  let totalAmount: number | null = null;
  let poDate: string | null = null;

  const headerRow = headerRowIdx >= 0 ? all[headerRowIdx] : undefined;
  const valueRow = headerRowIdx >= 0 ? all[headerRowIdx + 1] : undefined;
  if (headerRow && valueRow) {
    const at = (key: string) => {
      const i = headerRow.indexOf(key);
      return i >= 0 ? valueRow[i] : undefined;
    };
    poNumber = at('po_number') ?? null;
    vendorName = at('vendor') ?? null;
    poDate = at('po_date') ?? null;
    totalAmount = parseMoney(at('total') ?? null);
  }

  const lines: CanonicalPoLine[] = [];
  const linesHeader = lineHeaderIdx >= 0 ? all[lineHeaderIdx] : undefined;
  if (linesHeader) {
    for (let i = lineHeaderIdx + 1; i < all.length; i++) {
      const row = all[i];
      if (!row || row.every((c) => !c?.trim())) continue;
      const at = (key: RawLineKey): string | undefined => {
        const idx = linesHeader.indexOf(key);
        return idx >= 0 ? row[idx] : undefined;
      };
      const description = at('description') ?? null;
      const lineTotal = parseMoney(at('line_total') ?? null);
      lines.push({
        lineNumber: Number(at('line_number')) || lines.length + 1,
        lineType: classifyLine(description, { signedAmount: lineTotal ?? undefined }),
        qtyOrderedOriginal: parseQty(at('qty')),
        uomOriginal: normalizeUom(at('uom')),
        description,
        unitCost: parseMoney(at('unit_cost') ?? null),
        lineTotal,
        vendorItemNumber: at('vendor_item_number') || null,
        vendorProductNumber: at('vendor_product_number') || null,
        auxiliaryNumber: at('auxiliary_number') || null,
        coaCode: at('coa_code') || null,
      });
    }
  }

  return {
    poNumber,
    vendorName,
    poDate,
    description: null,
    preparedBy: null,
    workflow: null,
    reason: null,
    comments: null,
    shippingAddress: null,
    contactName: null,
    contactPhone: null,
    totalAmount,
    lines,
  };
}
