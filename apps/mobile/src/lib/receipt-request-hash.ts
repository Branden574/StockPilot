/**
 * The request hash mobile sends to post_receipt_v2 (SP-077).
 *
 * THE BUG: the PO receive screen passed `p_request_hash: idempotencyKey` — the
 * key itself. The RPC's contract (0013/0296) is "same key + same hash = return
 * the earlier receipt; same key + different hash = idempotency_conflict". With
 * the hash equal to the key, EVERY retry under the same key matched, including
 * a retry after the operator edited the quantities: the server silently
 * returned the OLD receipt as success and the edited lines were never
 * received, with no error anywhere.
 *
 * This mirrors apps/web/src/server/services/receiving.ts hashReceiptRequest's
 * normalisation (lines sorted by line id, quantities to four decimals, notes
 * included) so the same intent hashes the same on both clients. The web
 * digests the canonical JSON with SHA-256; React Native has no crypto without
 * a native module (expo-crypto would force a new binary), so this uses a
 * 64-bit FNV-1a over the same canonical JSON. The RPC only compares hashes
 * for equality under one key and itself SHA-256s the value it stores, so a
 * deterministic non-cryptographic digest satisfies the contract; nothing
 * security-relevant hangs on collision resistance here.
 */

export interface ReceiptLineForHash {
  po_line_id: string;
  qty_received: number;
  qty_accepted: number;
  qty_rejected?: number | null;
  unit_cost?: number | null;
  notes?: string | null;
}

export interface ReceiptRequestForHash {
  purchaseOrderId: string;
  warehouseId: string;
  notes?: string | null;
  lines: ReceiptLineForHash[];
}

const fixed4 = (n: number | null | undefined): string | null =>
  n === null || n === undefined ? null : Number(n).toFixed(4);

/** Canonical JSON: the SAME shape the web hashes, so intent equality is client-independent. */
export function canonicalReceiptRequest(input: ReceiptRequestForHash): string {
  return JSON.stringify({
    purchaseOrderId: input.purchaseOrderId,
    warehouseId: input.warehouseId,
    notes: input.notes ?? null,
    lines: [...input.lines]
      .sort((a, b) => a.po_line_id.localeCompare(b.po_line_id))
      .map((l) => ({
        poLineId: l.po_line_id,
        qtyReceived: fixed4(l.qty_received),
        qtyAccepted: fixed4(l.qty_accepted),
        qtyRejected: fixed4(l.qty_rejected ?? 0),
        unitCost: fixed4(l.unit_cost),
        notes: l.notes ?? null,
        lots: [],
        serials: [],
      })),
  });
}

/** 64-bit FNV-1a as 16 hex chars (two 32-bit lanes, seeded differently). */
function fnv1a64Hex(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function buildReceiptRequestHash(input: ReceiptRequestForHash): string {
  return `rcpt-${fnv1a64Hex(canonicalReceiptRequest(input))}`;
}
