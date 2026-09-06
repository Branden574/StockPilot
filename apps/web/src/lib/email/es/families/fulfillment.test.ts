import { describe, expect, it } from 'vitest';

import { assertEmailWeight } from '../components';
import { esEmailById } from '../registry';

import {
  FULFILLMENT_ORDERS_FROM,
  buildPrefEmailDelivery,
  buildViaStockPilotFrom,
  renderBackorderShippedEmail,
  renderPartialFulfilledEmail,
  renderPartialReceiptEmail,
  renderReturnPromptEmail,
} from './fulfillment';

import type { FulfillmentLineItem, PrefFooterUrls, RenderedEmail } from './fulfillment';

/**
 * Unit E5 render tests — fulfillment & returns family. Load-bearing:
 *   • subjects / preheaders byte-identical to the registry builders
 *     (and to the sample-world literals from es-tokens.js);
 *   • footer type per category (pref = manage+unsubscribe links; the
 *     signer receipt is EXTERNAL — no unsubscribe anywhere, explainer
 *     copy present);
 *   • motion per registry: route on back-shipped, reverse on
 *     return-prompt, NONE on partial (no Split-progress board asset)
 *     and NONE on the receipt (receipts are static);
 *   • stress: long values, missing first name → "Hi —", missing ETA,
 *     zero-qty edge, 200-line order stays under the Gmail clip budget;
 *   • no undefined/null/{{/raw-UUID leakage in any output.
 */

const URLS: PrefFooterUrls = {
  manage: 'https://app.example.com/dashboard/settings/notifications?email=req%40example.com',
  unsubscribe: 'https://app.example.com/dashboard/settings/notifications?email=req%40example.com',
  support: 'https://app.example.com/support',
};

const SAMPLE_ITEMS: FulfillmentLineItem[] = [
  { name: 'Field Radio', sku: 'RAD-001', qtyRequested: 12, qtyFulfilled: 12 },
  { name: 'Insulated Bottle 24 oz', sku: 'DRK-BTL-024', qtyRequested: 8, qtyFulfilled: 0 },
];

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Display text only — URLs may legitimately carry tokens. */
function withoutUrls(html: string): string {
  return html.replace(/href="[^"]*"/g, 'href=""').replace(/src="[^"]*"/g, 'src=""');
}

function expectClean(r: RenderedEmail): void {
  for (const out of [r.subject, r.preheader, r.html, r.text]) {
    expect(out).not.toMatch(/\bundefined\b/);
    expect(out).not.toMatch(/\bnull\b/);
    expect(out).not.toContain('{{');
    expect(out).not.toContain('[object Object]');
  }
  expect(withoutUrls(r.html)).not.toMatch(UUID_RE);
  expect(() => assertEmailWeight(r.html)).not.toThrow();
}

function samplePartial() {
  return renderPartialFulfilledEmail({
    orderNumber: '#7741-2205',
    recipientFirstName: 'Dana Fulton',
    recipientEmail: 'dana@example.com',
    delivered: 38,
    requested: 46,
    backordered: 8,
    deliveredOn: 'Apr 29',
    backorderEta: 'within 2 weeks',
    items: SAMPLE_ITEMS,
    orderUrl: 'https://app.example.com/dashboard/orders/abc',
    urls: URLS,
  });
}

describe('partial (Partially Fulfilled)', () => {
  it('subject + preheader byte-identical to the registry (sample world)', () => {
    const def = esEmailById('partial');
    const r = samplePartial();
    expect(r.subject).toBe(def.subject({ orderNumber: '#7741-2205' }));
    expect(r.subject).toBe('Order #7741-2205: partially fulfilled');
    expect(r.preheader).toBe(
      def.preheader({ delivered: 38, total: 46, back: 8, eta: 'within 2 weeks' }),
    );
    expect(r.preheader).toBe(
      '38 of 46 units delivered. 8 backordered — expected within 2 weeks.',
    );
    expectClean(r);
  });

  it('renders the split stat cards, per-line status column, and pref footer', () => {
    const r = samplePartial();
    // Tonal stat cards: Delivered (ok) + Backordered (warn).
    expect(r.html).toContain('>Delivered</div>');
    expect(r.html).toContain('>Backordered</div>');
    expect(r.html).toContain('>38</div>');
    expect(r.html).toContain('>8</div>');
    // Per-line status pills in the item table.
    expect(r.html).toContain('>Status</td>');
    expect(r.html).toContain('8 backordered');
    expect(r.html).toContain('Field Radio');
    // Preference footer: manage + unsubscribe links, boilerplate.
    expect(r.html).toContain('>Manage email preferences</a>');
    expect(r.html).toContain('>Unsubscribe</a>');
    expect(r.html).toContain('Order-status updates for orders placed by dana@example.com.');
  });

  it('is STATIC — registry lists Split-progress with no motion-board asset', () => {
    expect(samplePartial().html).not.toContain('/email/motion/');
  });

  it('greets first-name-only and falls back to "Hi —" when the name is missing', () => {
    expect(samplePartial().html).toContain('Hi Dana —');
    const anon = renderPartialFulfilledEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: null,
      recipientEmail: 'dana@example.com',
      delivered: 38,
      requested: 46,
      backordered: 8,
      orderUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(anon.html).toContain('Hi — ');
    expect(anon.text).toContain('Hi —');
    expectClean(anon);
  });

  it('missing ETA: preheader/stat/body clauses elide gracefully', () => {
    const r = renderPartialFulfilledEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'Dana',
      recipientEmail: 'dana@example.com',
      delivered: 38,
      requested: 46,
      backordered: 8,
      orderUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(r.preheader).toBe('38 of 46 units delivered. 8 backordered.');
    expect(r.html).not.toContain('expected');
    expect(r.html).toContain('as soon as they&rsquo;re back in stock');
    expectClean(r);
  });

  it('zero-qty edge: a fully-backordered line renders qty 0 with a warn pill', () => {
    const r = samplePartial();
    expect(r.html).toContain('&times;0');
    expectClean(r);
  });

  it('stress: long names + 200 lines stays under the Gmail clip budget (capped table)', () => {
    const longName = 'Very Long Industrial Equipment Item Name That Keeps Going '.repeat(4);
    const items: FulfillmentLineItem[] = Array.from({ length: 200 }, (_, i) => ({
      name: `${longName} ${i}`,
      sku: `SKU-${i}-WITH-A-VERY-LONG-SUFFIX`,
      qtyRequested: 5,
      qtyFulfilled: i % 3 === 0 ? 0 : 5,
    }));
    const r = renderPartialFulfilledEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'A'.repeat(80),
      recipientEmail: 'dana@example.com',
      delivered: 500,
      requested: 1000,
      backordered: 500,
      backorderEta: 'B'.repeat(120),
      items,
      orderUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(r.html).toContain('+ 170 more lines');
    expectClean(r);
  });

  it('escapes hostile merge values', () => {
    const r = renderPartialFulfilledEmail({
      orderNumber: '#X',
      recipientFirstName: '<script>alert(1)</script>',
      recipientEmail: 'a@b.co',
      delivered: 1,
      requested: 2,
      backordered: 1,
      items: [{ name: '<img onerror=x>', sku: '"><b>', qtyRequested: 1, qtyFulfilled: 0 }],
      orderUrl: 'https://app.example.com/o',
      urls: URLS,
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('<img onerror');
  });
});

describe('back-shipped (Backordered Items Shipped)', () => {
  const full = () =>
    renderBackorderShippedEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'Dana',
      recipientEmail: 'dana@example.com',
      unitsShipped: 8,
      warehouse: 'DCIV — Fresno',
      shipDate: 'May 8',
      method: 'ground',
      destination: 'CVW — Manchester',
      trackUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });

  it('subject + preheader byte-identical to the registry (sample world)', () => {
    const def = esEmailById('back-shipped');
    const r = full();
    expect(r.subject).toBe(def.subject({ orderNumber: '#7741-2205' }));
    expect(r.subject).toBe('Order #7741-2205: backordered items shipped');
    expect(r.preheader).toBe(
      def.preheader({ units: 8, warehouse: 'DCIV — Fresno', shipDate: 'May 8', method: 'ground' }),
    );
    expect(r.preheader).toBe('The remaining 8 units left DCIV — Fresno May 8 via ground.');
    expectClean(r);
  });

  it('embeds the route motion asset with reserved dimensions + carrying alt text', () => {
    const r = full();
    expect(r.html).toContain('https://stockpilotusa.com/email/motion/route@2x.gif');
    expect(r.html).toContain('width="528" height="194"');
    expect(r.html).toContain('Route progress: package en route to CVW — Manchester');
  });

  it('odd cell count: the trailing "To" destination cell renders (not dropped)', () => {
    // shipDate + warehouse + destination = 3 cells; the pairing loop used
    // to emit only complete pairs, silently discarding the destination.
    const r = full();
    expect(r.html).toContain('>To</div>');
    const gridIdx = r.html.indexOf('>To</div>');
    expect(gridIdx).toBeGreaterThan(-1);
    expect(r.html.slice(gridIdx, gridIdx + 400)).toContain('CVW — Manchester');
  });

  it('hero alt escapes the destination (attribute context)', () => {
    const r = renderBackorderShippedEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'Dana',
      recipientEmail: 'dana@example.com',
      unitsShipped: 8,
      destination: 'Bay "Dock 2" & Co',
      trackUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(r.html).toContain('en route to Bay &quot;Dock 2&quot; &amp; Co');
    expect(r.html).not.toContain('to Bay "Dock 2"');
  });

  it('degrades when only the unit count is known (production wiring today)', () => {
    const r = renderBackorderShippedEmail({
      orderNumber: '#A1B2C3D4',
      recipientFirstName: null,
      recipientEmail: 'req@example.com',
      unitsShipped: 8,
      trackUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(r.preheader).toBe('The remaining 8 units are on the way.');
    expect(r.html).toContain('The last 8 units are moving.');
    expect(r.html).toContain('Hi — ');
    expectClean(r);
  });

  it('degrades with no unit count at all', () => {
    const r = renderBackorderShippedEmail({
      orderNumber: '#A1B2C3D4',
      recipientEmail: 'req@example.com',
      trackUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(r.preheader).toBe('The remaining units are on the way.');
    expect(r.html).toContain('The rest of your order is moving.');
    expectClean(r);
  });

  it('pref footer + link fallback', () => {
    const r = full();
    expect(r.html).toContain('>Manage email preferences</a>');
    expect(r.html).toContain('>Unsubscribe</a>');
    expect(r.html).toContain('Or paste this link into your browser');
  });
});

describe('partial-receipt (Partial Delivery Receipt)', () => {
  const full = () =>
    renderPartialReceiptEmail({
      orderNumber: '#7741-2205',
      supplierName: 'L4L North Region',
      signerName: 'M. Okafor',
      signedAt: 'Apr 29, 2:12 PM PT',
      destination: 'CVW — Manchester',
      unitsReceived: 38,
      unitsTotal: 46,
      unitsPending: 8,
      pendingEta: 'within 2 weeks',
      items: SAMPLE_ITEMS,
      appUrl: 'https://stockpilotusa.com',
    });

  it('subject + preheader byte-identical to the registry (sample world)', () => {
    const def = esEmailById('partial-receipt');
    const r = full();
    expect(r.subject).toBe(def.subject({ orderNumber: '#7741-2205' }));
    expect(r.subject).toBe('Order #7741-2205: partial delivery receipt');
    expect(r.preheader).toBe(
      def.preheader({ units: 38, destination: 'CVW — Manchester', date: 'Apr 29, 2:12 PM PT' }),
    );
    expectClean(r);
  });

  it('EXTERNAL footer: no unsubscribe anywhere, explainer copy present', () => {
    const r = full();
    expect(r.html).not.toContain('Unsubscribe');
    expect(r.html).not.toContain('Manage email preferences');
    expect(r.html).toContain(
      'one-time receipt because you signed for a delivery managed by L4L North Region through StockPilot',
    );
    expect(r.html).toContain('>Contact the sender</a>');
  });

  it('receipt language, zero jargon, static (no motion), no dead CTA', () => {
    const r = full();
    expect(r.html).toContain('no account or app needed');
    expect(r.html).not.toContain('/email/motion/');
    // No receipt URL exists today — the CTA button is omitted, note kept.
    expect(r.html).not.toContain('View receipt');
    expect(r.html).toContain('The pending units ship separately');
    // Zero StockPilot-internal jargon for the external signer.
    for (const jargon of ['dashboard', 'workspace', 'requester_', 'order_request']) {
      expect(r.html.toLowerCase()).not.toContain(jargon);
    }
  });

  it('receipt card rows: signer, time, supplier, received, pending', () => {
    const r = full();
    expect(r.html).toContain('M. Okafor');
    expect(r.html).toContain('Signature time');
    expect(r.html).toContain('L4L North Region &middot; via StockPilot');
    expect(r.html).toContain('38 of 46');
    expect(r.html).toContain('8 units &middot; expected within 2 weeks');
  });

  it('degrades without supplier/destination/eta (long org name stress too)', () => {
    const r = renderPartialReceiptEmail({
      orderNumber: '#A1B2C3D4',
      signerName: 'S'.repeat(120),
      signedAt: 'Jul 20, 9:12 PM UTC',
      unitsReceived: 3,
      unitsTotal: 10,
      unitsPending: 7,
      appUrl: 'https://stockpilotusa.com',
    });
    expect(r.preheader).toBe('Receipt for 3 units received and signed Jul 20, 9:12 PM UTC.');
    expect(r.html).toContain(
      'one-time receipt because you signed for a delivery managed through StockPilot',
    );
    expect(r.html).not.toContain('Supplier');
    expectClean(r);

    const longOrg = renderPartialReceiptEmail({
      orderNumber: '#A1B2C3D4',
      supplierName: 'Extremely Long Supplier Organization Name '.repeat(6),
      signerName: 'M. Okafor',
      signedAt: 'Jul 20, 9:12 PM UTC',
      unitsReceived: 3,
      unitsTotal: 10,
      unitsPending: 7,
      appUrl: 'https://stockpilotusa.com',
    });
    expectClean(longOrg);
  });
});

describe('return-prompt (Return Prompt)', () => {
  const full = () =>
    renderReturnPromptEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'Dana',
      recipientEmail: 'dana@example.com',
      deliveredOn: 'Apr 29',
      returnBy: 'May 27, 2026',
      destination: 'CVW — Manchester',
      startUrl: 'https://app.example.com/returns/request/tok123',
      urls: URLS,
    });

  it('subject stays the registry subject (rec: refinement NOT implemented)', () => {
    const def = esEmailById('return-prompt');
    const r = full();
    expect(r.subject).toBe(def.subject({}));
    expect(r.subject).toBe('Need to return anything from your order?');
    // The refined subject awaiting sign-off must not leak in.
    expect(r.subject).not.toContain('returns open through');
  });

  it('preheader + badge byte-identical to the registry (sample world)', () => {
    const def = esEmailById('return-prompt');
    const r = full();
    expect(r.preheader).toBe(
      def.preheader({ orderNumber: '#7741-2205', returnBy: 'May 27, 2026' }),
    );
    expect(r.html).toContain(def.badge.label({ deliveredOn: 'Apr 29' }));
    expectClean(r);
  });

  it('reverse-route motion + CTA to the return portal + pref footer', () => {
    const r = full();
    expect(r.html).toContain('https://stockpilotusa.com/email/motion/reverse@2x.gif');
    expect(r.html).toContain('width="528" height="194"');
    expect(r.html).toContain('Start a return');
    expect(r.html).toContain('https://app.example.com/returns/request/tok123');
    expect(r.html).toContain('>Manage email preferences</a>');
    expect(r.html).toContain('>Unsubscribe</a>');
    expect(r.html).toContain('A single post-delivery notice for orders placed by dana@example.com.');
    expect(r.text).toContain('https://app.example.com/returns/request/tok123');
  });

  it('omits the Return-policy secondary (no policy page exists) unless given one', () => {
    expect(full().html).not.toContain('Return policy');
    const withPolicy = renderReturnPromptEmail({
      orderNumber: '#7741-2205',
      recipientEmail: 'dana@example.com',
      deliveredOn: 'Apr 29',
      startUrl: 'https://app.example.com/returns/request/tok123',
      policyUrl: 'https://app.example.com/returns/policy',
      urls: URLS,
    });
    expect(withPolicy.html).toContain('>Return policy</a>');
  });

  it('degrades without a return window / name / destination', () => {
    const r = renderReturnPromptEmail({
      orderNumber: '#A1B2C3D4',
      recipientEmail: 'req@example.com',
      deliveredOn: 'Jul 20',
      startUrl: 'https://app.example.com/returns/request/tok123',
      urls: URLS,
    });
    expect(r.preheader).toBe('Order #A1B2C3D4 · unused items can be returned. Takes about a minute.');
    expect(r.html).toContain('Hi — ');
    expect(r.html).toContain('Delivered Jul 20');
    expect(r.html).toContain('Open now');
    expectClean(r);
  });
});

/**
 * Greeting contract — the ONE thing every live caller depends on.
 *
 * All three greeting-bearing renderers are fed a FULL name in prod:
 * order-handover-notify.ts passes `args.requesterName` to
 * renderPartialFulfilledEmail/renderBackorderShippedEmail, and
 * return-prompt.ts passes `order.requester_name` as
 * `recipientFirstName`. The family therefore takes the first word
 * itself — the sibling family lib/email/es/families/maintenance.ts uses
 * the WHOLE string (its callers pre-split with their own firstNameOf),
 * so "simplifying" this family to match that one would start greeting
 * real people as "Hi Jane Doe —" in every handover and return email.
 *
 * Only the HTML of `partial` was pinned before; the text half and the
 * other two templates were free to drift. Every greeting surface is
 * pinned here so that drift fails a test instead of a customer's inbox.
 */
describe('greeting contract: a full name is always greeted by first name', () => {
  it('partial greets by first name in BOTH html and text', () => {
    const r = samplePartial(); // recipientFirstName: 'Dana Fulton'
    expect(r.html).toContain('Hi Dana —');
    expect(r.html).not.toContain('Hi Dana Fulton');
    expect(r.text).toContain('Hi Dana —');
    expect(r.text).not.toContain('Hi Dana Fulton');
  });

  it('back-shipped greets by first name in BOTH html and text', () => {
    const r = renderBackorderShippedEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'Dana Fulton',
      recipientEmail: 'dana@example.com',
      unitsShipped: 8,
      warehouse: 'DCIV — Fresno',
      shipDate: 'May 8',
      method: 'ground',
      destination: 'CVW — Manchester',
      trackUrl: 'https://app.example.com/dashboard/orders/abc',
      urls: URLS,
    });
    expect(r.html).toContain('Hi Dana —');
    expect(r.html).not.toContain('Hi Dana Fulton');
    expect(r.text).toContain('Hi Dana —');
    expect(r.text).not.toContain('Hi Dana Fulton');
    expectClean(r);
  });

  it('return-prompt greets by first name in BOTH html and text', () => {
    const r = renderReturnPromptEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: 'Dana Fulton',
      recipientEmail: 'dana@example.com',
      deliveredOn: 'Apr 29',
      returnBy: 'May 27, 2026',
      destination: 'CVW — Manchester',
      startUrl: 'https://app.example.com/returns/request/tok123',
      urls: URLS,
    });
    expect(r.html).toContain('Hi Dana —');
    expect(r.html).not.toContain('Hi Dana Fulton');
    expect(r.text).toContain('Hi Dana —');
    expect(r.text).not.toContain('Hi Dana Fulton');
    expectClean(r);
  });

  it('extra whitespace and a middle name still yield the first word', () => {
    const r = renderReturnPromptEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: '  Dana  Mae Fulton ',
      recipientEmail: 'dana@example.com',
      deliveredOn: 'Apr 29',
      startUrl: 'https://app.example.com/returns/request/tok123',
      urls: URLS,
    });
    expect(r.html).toContain('Hi Dana —');
    expect(r.text).toContain('Hi Dana —');
  });

  it('a name that is only whitespace falls back to "Hi —" in html and text', () => {
    const r = renderReturnPromptEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: '   ',
      recipientEmail: 'dana@example.com',
      deliveredOn: 'Apr 29',
      startUrl: 'https://app.example.com/returns/request/tok123',
      urls: URLS,
    });
    expect(r.html).toContain('Hi — ');
    expect(r.text).toContain('Hi —');
    expectClean(r);
  });

  it('the html greeting escapes a hostile first name; the text one does not double-escape', () => {
    const r = renderReturnPromptEmail({
      orderNumber: '#7741-2205',
      recipientFirstName: '<script>alert(1)</script> Fulton',
      recipientEmail: 'dana@example.com',
      deliveredOn: 'Apr 29',
      startUrl: 'https://app.example.com/returns/request/tok123',
      urls: URLS,
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.text).toContain('Hi <script>alert(1)</script> —');
  });
});

describe('senders + delivery helpers', () => {
  it('orders sender matches the registry byte-form', () => {
    expect(FULFILLMENT_ORDERS_FROM).toBe('StockPilot <orders@stockpilotusa.com>');
    expect(esEmailById('partial').from).toBe(FULFILLMENT_ORDERS_FROM);
    expect(esEmailById('back-shipped').from).toBe(FULFILLMENT_ORDERS_FROM);
    expect(esEmailById('return-prompt').from).toBe(FULFILLMENT_ORDERS_FROM);
  });

  it('builds the via-StockPilot display-from (registry sample byte-form)', () => {
    expect(buildViaStockPilotFrom('L4L North Region')).toBe(
      'L4L North Region via StockPilot <orders@stockpilotusa.com>',
    );
    expect(esEmailById('partial-receipt').from).toBe(
      buildViaStockPilotFrom('L4L North Region'),
    );
  });

  it('quotes org names with specials and neutralizes header injection', () => {
    expect(buildViaStockPilotFrom("Bob's Supply, Inc.")).toBe(
      '"Bob\'s Supply, Inc. via StockPilot" <orders@stockpilotusa.com>',
    );
    const evil = buildViaStockPilotFrom('Evil\r\nBcc: victim@example.com');
    expect(evil).not.toMatch(/[\r\n]/);
    expect(buildViaStockPilotFrom('  ')).toBe('StockPilot <orders@stockpilotusa.com>');
    expect(buildViaStockPilotFrom(null)).toBe('StockPilot <orders@stockpilotusa.com>');
  });

  it('account holders get the in-app manage link and a plain List-Unsubscribe header', () => {
    const d = buildPrefEmailDelivery({
      appUrl: 'https://app.example.com/',
      recipientEmail: 'user@example.com',
      isAccountHolder: true,
    });
    expect(d.urls.manage).toBe(
      'https://app.example.com/dashboard/settings/notifications?email=user%40example.com',
    );
    expect(d.headers['List-Unsubscribe']).toContain('dashboard/settings/notifications');
    // No RFC 8058 one-click against the login-gated page.
    expect(d.headers['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('public recipients always get List-Unsubscribe (signed one-click when the secret allows)', () => {
    const d = buildPrefEmailDelivery({
      appUrl: 'https://app.example.com',
      recipientEmail: 'anon@example.com',
      isAccountHolder: false,
    });
    expect(d.headers['List-Unsubscribe']).toBeDefined();
    expect(d.urls.manage).toBe(d.urls.unsubscribe);
    if (d.headers['List-Unsubscribe-Post']) {
      expect(d.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(d.urls.unsubscribe).toContain('/unsubscribe?e=');
    }
  });
});
