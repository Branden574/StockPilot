import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wiring pins for the phone's returns screens (returns RX-1). The mobile
 * suite has no React Native renderer, so this reads the files and pins the
 * contracts a screen could otherwise lose silently:
 *
 *   - the routes are registered (drawer list, stacked RMA screen, cold-start
 *     shim) and the drawer entry has its icon;
 *   - every return action is ONLINE ONLY: the workbench feeds the live
 *     connection state into the actions, the sheet disables its submit
 *     offline with "Needs a connection.", and NO outbox kind exists for a
 *     return (queue.ts is unchanged);
 *   - the order screen's create sheet mints a key when it opens, sends the
 *     item-is-here switch (off by default), counts pending returns in what
 *     remains, and links each RMA to its workbench.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('routes', () => {
  it('the drawer lists Returns, the stack holds the RMA screen, and the shim redirects', () => {
    expect(read('app/(drawer)/_layout.tsx')).toContain('<Drawer.Screen name="returns"');
    expect(read('app/_layout.tsx')).toContain('<Stack.Screen name="returns/[id]"');
    expect(read('app/dashboard/returns/[id].tsx')).toContain("pathname: '/returns/[id]'");
    expect(read('src/lib/nav-icons.ts')).toMatch(/\n\s+Undo2,\n/);
  });
});

describe('the list filters', () => {
  it('are buttons with a selected state, never the tab role iOS gives no trait (VoiceOver says they can be pressed)', () => {
    const list = code(read('app/(drawer)/returns.tsx'));
    const chip = list.slice(list.indexOf('filters.map('), list.indexOf('</Pressable>', list.indexOf('filters.map(')));
    expect(chip).toContain('accessibilityRole="button"');
    expect(chip).toContain('accessibilityState={{ selected: filter === f.id }}');
    expect(list).not.toMatch(/accessibilityRole="tab(list)?"/);
  });
});

describe('online only', () => {
  const view = code(read('src/components/return-workbench-view.tsx'));
  const sheet = code(read('src/components/return-action-sheet.tsx'));

  it('the workbench feeds the live connection state into the actions', () => {
    expect(view).toContain('isOfflineState(useNetworkState())');
    expect(view).toMatch(/workbenchActions\(wb, \{ itemIsHere: wb\.createdOnCounter, online: !offline, busy \}\)/);
    expect(view).toContain('disabled={disabled}');
  });

  it('the sheet follows the live online prop and says why it is disabled', () => {
    expect(sheet).toContain('READINESS_NEEDS_CONNECTION_COPY');
    expect(sheet).toMatch(/const disabledReason = !online\s*\?\s*READINESS_NEEDS_CONNECTION_COPY/);
    expect(sheet).toContain('disabled={!canSubmit}');
    expect(sheet).toContain('online={online}');
    expect(sheet).toMatch(/if \(!canSubmit\) return;/);
  });

  it('no outbox kind exists for a return, and the returns client never queues', () => {
    const queue = code(read('src/lib/queue.ts'));
    const kinds = queue.slice(queue.indexOf('export type PendingActionKind'), queue.indexOf(';', queue.indexOf('export type PendingActionKind')));
    expect(kinds).not.toMatch(/return/i);
    expect([...kinds.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      'adjust_stock',
      'receive_po_line',
      'record_count',
      'create_book',
      'distribute_bundle',
      'upload_image',
      'size_count_event',
    ]);
    const client = code(read('src/lib/returns-api.ts'));
    expect(client).not.toMatch(/from '\.\/(queue|outbox|db|sync)'/);
  });
});

describe('the order screen', () => {
  const screen = code(read('app/order/[id].tsx'));

  it('mints a key when the create sheet opens and sends it with the item-is-here switch', () => {
    expect(screen).toMatch(/function openReturnSheet\(\) \{[\s\S]*?setReturnKey\(mintReturnKey\(\)\);[\s\S]*?setReturnItemIsHere\(false\);/);
    expect(screen).toMatch(/idempotencyKey: returnKey,\s*itemIsHere: returnItemIsHere,/);
    expect(screen).toContain('useState(false);');
  });

  it('counts pending returns in what remains (the server number)', () => {
    expect(screen).toContain('pendingReturnQuantities(order.returns)');
  });

  it('links each RMA to its workbench and refuses to submit offline', () => {
    expect(screen).toContain('router.push(`/returns/${r.id}` as Href)');
    expect(screen).toMatch(/disabled=\{returnSubmitting \|\| offline\}/);
  });
});
