import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mapPostReceiptError } from './receipt-post-error';

describe('mapPostReceiptError', () => {
  it('treats idempotency_conflict as "the first attempt landed": new intent + reload, never a bare retry', () => {
    const a = mapPostReceiptError({ message: 'idempotency_conflict', code: '40001' });
    expect(a.resetIntent).toBe(true);
    expect(a.reload).toBe(true);
    // The operator must be told the earlier post SUCCEEDED, or they will
    // re-enter the same quantities and double-receive.
    expect(a.body.toLowerCase()).toContain('outstanding');
    expect(a.body).not.toContain('idempotency_conflict');
  });

  it('keeps the same intent for errors that wrote nothing (the whole RPC is one transaction)', () => {
    for (const message of [
      'po_already_closed',
      'forbidden',
      'negative_quantity',
      'po_line_not_found',
      'po_not_found',
    ]) {
      const a = mapPostReceiptError({ message });
      expect(a.resetIntent, message).toBe(false);
      expect(a.reload, message).toBe(false);
      // Every named raise string gets a sentence a receiver can act on —
      // never the raw Postgres token (2026-07-21: a raw code is how the
      // over-receipt block stayed invisible to warehouse staff for weeks).
      expect(a.body, message).not.toContain(message);
    }
  });

  it('maps the lot/serial raise strings specific-before-general', () => {
    expect(mapPostReceiptError({ message: 'serial_count_exceeds_quantity' }).body).toMatch(
      /more serial numbers/i,
    );
    expect(mapPostReceiptError({ message: 'serial_count_mismatch' }).body).toMatch(
      /exactly one serial number/i,
    );
    expect(mapPostReceiptError({ message: 'lot_qty_mismatch' }).body).toMatch(/add up/i);
    expect(mapPostReceiptError({ message: 'lot_required' }).body).toMatch(/lot-tracked/i);
  });

  it('maps a duplicate serial (23505 on serial_registry), which carries no named RPC code', () => {
    const a = mapPostReceiptError({
      message: 'duplicate key value violates unique constraint',
      code: '23505',
      details: 'Key (organization_id, item_id, serial_number)=(…) already exists in serial_registry.',
    });
    expect(a.body).toMatch(/already registered/i);
    expect(a.resetIntent).toBe(false);
  });

  it('falls through to the raw message so an unmapped failure stays diagnosable', () => {
    const a = mapPostReceiptError({ message: 'connection reset by peer' });
    expect(a.title).toBe('Receive failed');
    expect(a.body).toContain('connection reset by peer');
    expect(a.resetIntent).toBe(false);
  });

  it('never returns an empty body, even for an error object with no message', () => {
    expect(mapPostReceiptError({}).body.length).toBeGreaterThan(0);
    expect(mapPostReceiptError({ message: null }).body.length).toBeGreaterThan(0);
  });
});

/**
 * Source-level wiring pin: the screen imports native modules at top level, so
 * vitest cannot render it (see vitest.config.ts). These assertions are what
 * stops the receipt-post failure branch regressing to a raw alert.
 *
 * The branch is anchored on the API call, not on `supabase.rpc(...)`: SP-007b
 * moved this post off the RPC and onto `/api/v1/po/<id>/receipts` so the
 * receipt runs through ReceivingService (audit row, `receipt.posted` outbox
 * event, `po.received` webhook). The recovery policy pinned below is
 * unchanged by that move — only where the error comes from changed.
 */
describe('po/[id].tsx receipt-post failure branch', () => {
  const screen = readFileSync(path.resolve(__dirname, '../../app/po/[id].tsx'), 'utf8');
  const start = screen.indexOf('`/api/v1/po/${id}/receipts`');
  // End at the SUCCESS comment, not at the 'Posted' alert: the success path
  // clears idemKeyRef too, and including it would make the reset assertion
  // below pass for free.
  const branch = screen.slice(start, screen.indexOf('// Posted:', start));

  it('routes the failure through mapPostReceiptError instead of alerting the raw message', () => {
    expect(start).toBeGreaterThan(-1);
    expect(screen).toMatch(
      /import \{ mapPostReceiptError \} from '@\/lib\/receipt-post-error'/,
    );
    expect(branch).toMatch(/mapPostReceiptError\(\{/);
    expect(branch).not.toMatch(/Alert\.alert\('Receive failed', error\.message\)/);
  });

  it('retires the idempotency key and re-reads the PO when the mapping says the first attempt landed', () => {
    // Without this the hash fix (SP-077) leaves the receiver permanently
    // stuck: the retained key + the edited lines' new hash raise
    // idempotency_conflict on every further attempt.
    expect(branch).toMatch(/resetIntent/);
    expect(branch).toMatch(/idemKeyRef\.current = null/);
    expect(branch).toMatch(/load\(\)/);
  });
});
