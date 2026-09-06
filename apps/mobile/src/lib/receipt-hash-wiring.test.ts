import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * How the PO receive screen posts a receipt — pinned against two regressions.
 *
 * SP-077 (wave 1): the screen passed `p_request_hash: idempotencyKey` to the
 * `post_receipt_v2` RPC, so every retry under one key matched and an EDITED
 * receipt silently returned the earlier one as success.
 *
 * SP-007b (this wave): the screen called that RPC AT ALL. The RPC writes the
 * receipt and the stock, but skips everything `ReceivingService.postReceipt`
 * does around it — the audit row, the `receipt.posted` outbox event the
 * QuickBooks connector subscribes to, the `po.received` webhook, the
 * auto-unarchive, the inventory-list revalidation. Every delivery received on
 * a phone was invisible to accounting and to Activity.
 *
 * The fix subsumes SP-077: the screen now POSTs `/api/v1/po/<id>/receipts`
 * and the SERVER computes the request hash (receiving.ts hashReceiptRequest),
 * so a key-as-hash can no longer exist on this path at all. These assertions
 * are source-text greps because the screen imports native Expo modules and
 * cannot be rendered under this (node, src/**-scoped) vitest project.
 */
describe('po/[id].tsx receipt-post wiring', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/po/[id].tsx'), 'utf8');

  it('posts through the v1 receipts route, not the post_receipt_v2 RPC', () => {
    expect(screen).toMatch(/api<[^>]*>\(\s*`\/api\/v1\/po\/\$\{id\}\/receipts`/);
    expect(screen).toMatch(/method: 'POST'/);
    // The RPC call — and with it the client-side request hash — is gone.
    // (Matched on the CALL, not the bare name: the comment above the api()
    // call names the RPC on purpose, to explain why it is no longer used.)
    expect(screen).not.toMatch(/supabase\.rpc\(\s*'post_receipt_v2'/);
    expect(screen).not.toMatch(/p_request_hash:/);
    expect(screen).not.toMatch(/buildReceiptRequestHash\(/);
  });

  it('still sends ONE idempotency key per intent, kept across retries', () => {
    expect(screen).toMatch(/idempotencyKey/);
    expect(screen).toMatch(/idemKeyRef\.current = `mobile-\$\{id\}/);
  });

  it('still routes failures through mapPostReceiptError', () => {
    expect(screen).toMatch(
      /import \{ mapPostReceiptError \} from '@\/lib\/receipt-post-error'/,
    );
    expect(screen).toMatch(/mapPostReceiptError\(/);
    expect(screen).toMatch(/action\.resetIntent/);
    expect(screen).toMatch(/action\.reload/);
  });

  /**
   * The route answers a conflict with `details.reason`, because HTTP 409
   * cannot separate "your first post committed" (retire the key + reload)
   * from "the PO is closed" / "duplicate serial" (keep the key). The screen
   * must feed that reason token into mapPostReceiptError, whose recovery
   * policy is keyed on the raw token strings.
   */
  it('feeds the route reason token into the error mapper', () => {
    expect(screen).toMatch(/details/);
    expect(screen).toMatch(/reason/);
  });
});
