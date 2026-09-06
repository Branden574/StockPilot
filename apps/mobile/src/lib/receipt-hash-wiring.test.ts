import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/** The PO receive screen must hash the REQUEST, never pass the key as the hash (SP-077). */
describe('po/[id].tsx post_receipt_v2 wiring', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/po/[id].tsx'), 'utf8');
  it('passes buildReceiptRequestHash(...) as p_request_hash and never the idempotency key', () => {
    const call = screen.slice(screen.indexOf("supabase.rpc('post_receipt_v2'"), screen.indexOf('setPosting(false)', screen.indexOf("supabase.rpc('post_receipt_v2'")));
    expect(call).toMatch(/p_request_hash: requestHash/);
    expect(call).not.toMatch(/p_request_hash: idempotencyKey/);
    expect(screen).toMatch(/import \{ buildReceiptRequestHash \} from '@\/lib\/receipt-request-hash'/);
    expect(screen).toMatch(/const requestHash = buildReceiptRequestHash\(\{/);
  });
});
