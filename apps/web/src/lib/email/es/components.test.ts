import { describe, expect, it } from 'vitest';

import {
  assertEmailWeight,
  banner,
  brandStrip,
  detailRows,
  emailShell,
  escapeHtml,
  eventCard,
  footer,
  helpRow,
  internalStrip,
  itemTable,
  kpiGrid,
  orderTimeline,
  previewBanner,
  rentalAssetCard,
  statusPill,
  workspaceCard,
} from './components';
import { ES_LIGHT, ES_MAX_HTML_BYTES, esAssetUrl } from './tokens';

import type { EsStatusVariant } from './tokens';

describe('esAssetUrl', () => {
  it('serves from /email/ under the public web origin', () => {
    expect(esAssetUrl('lock@2x.gif')).toBe('https://stockpilotusa.com/email/lock@2x.gif');
    expect(esAssetUrl('logo-mark-dark.png')).toBe(
      'https://stockpilotusa.com/email/logo-mark-dark.png',
    );
  });

  it('supports the GoogleImageProxy cache-bust version', () => {
    expect(esAssetUrl('logo-mark-light.png', 2)).toBe(
      'https://stockpilotusa.com/email/logo-mark-light.png?v=2',
    );
  });
});

describe('assertEmailWeight', () => {
  it('passes under the 102KB Gmail clip budget', () => {
    expect(() => assertEmailWeight('<html>ok</html>')).not.toThrow();
    expect(() => assertEmailWeight('x'.repeat(ES_MAX_HTML_BYTES))).not.toThrow();
  });

  it('throws with the actual size when over budget', () => {
    expect(() => assertEmailWeight('x'.repeat(ES_MAX_HTML_BYTES + 1))).toThrow(
      /104449 bytes — over the 104448-byte/,
    );
  });

  it('measures utf-8 bytes, not JS string length', () => {
    // Em dashes are 3 bytes each in UTF-8.
    const s = '—'.repeat(35000);
    expect(s.length).toBeLessThan(ES_MAX_HTML_BYTES);
    expect(() => assertEmailWeight(s)).toThrow();
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<b>&"'`)).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });
});

describe('statusPill', () => {
  const filled: EsStatusVariant[] = ['ok', 'info', 'warn', 'err', 'neutral', 'purple'];

  it('renders all six filled variants with their token pairs and dark-mode class', () => {
    for (const v of filled) {
      const html = statusPill({ variant: v, label: 'Label' });
      expect(html).toContain(`class="${v}pill"`);
      expect(html).toContain(`background:${ES_LIGHT.status[v].bg}`);
      expect(html).toContain(`color:${ES_LIGHT.status[v].fg}`);
      expect(html).toContain('&#9679; Label');
    }
  });

  it('renders sec as outlined (border, no fill)', () => {
    const html = statusPill({ variant: 'sec', label: 'Security' });
    expect(html).toContain('class="secpill"');
    expect(html).toContain('border:1px solid rgba(12,12,14,0.35)');
    expect(html).not.toContain('background:');
  });

  it('drops the dot on request (digest range pill)', () => {
    expect(statusPill({ variant: 'info', label: 'Jun 8 – 14', dot: false })).not.toContain(
      '&#9679;',
    );
  });
});

describe('orderTimeline', () => {
  it('renders exactly the given stages — nothing invented', () => {
    const html = orderTimeline({
      tone: 'neutral',
      steps: [
        { label: 'Received', state: 'done' },
        { label: 'Approved', state: 'done' },
        { label: 'Cancelled', state: 'terminal' },
      ],
    });
    expect(html.match(/<td/g)).toHaveLength(3);
    for (const absent of ['Packing', 'Ready', 'In transit', 'Delivered']) {
      expect(html).not.toContain(absent);
    }
    // Terminal always uses the err accent regardless of tone.
    expect(html).toContain(`color:${ES_LIGHT.status.err.fg};font-weight:700">&#9679;<br>Cancelled`);
  });

  it('currentDotImgSrc swaps ONLY the current dot for the animated tick', () => {
    const html = orderTimeline({
      tone: 'info',
      currentDotImgSrc: esAssetUrl('motion/tick@2x.gif'),
      steps: [
        { label: 'Received', state: 'current' },
        { label: 'Approved', state: 'upcoming' },
      ],
    });
    expect(html).toContain(
      '<img src="https://stockpilotusa.com/email/motion/tick@2x.gif" width="11" height="11"',
    );
    // Upcoming keeps its glyph; without the option nothing changes.
    expect(html).toContain('&#9675;<br>Approved');
    const plain = orderTimeline({
      tone: 'info',
      steps: [{ label: 'Received', state: 'current' }],
    });
    expect(plain).toContain('&#9679;<br>Received');
    expect(plain).not.toContain('<img');
  });

  it('distinguishes done / current / upcoming glyphs and colors', () => {
    const html = orderTimeline({
      tone: 'ok',
      steps: [
        { label: 'Received', state: 'done' },
        { label: 'Approved', state: 'current' },
        { label: 'Packing', state: 'upcoming' },
      ],
    });
    expect(html).toContain(`class="ink3" style="color:${ES_LIGHT.ink3}">&#9679;<br>Received`);
    expect(html).toContain(
      `style="color:${ES_LIGHT.status.ok.fg};font-weight:700">&#9679;<br>Approved`,
    );
    expect(html).toContain(`class="ink4" style="color:${ES_LIGHT.ink4}">&#9675;<br>Packing`);
  });
});

describe('itemTable', () => {
  const items = [
    { nameHtml: 'Cotton Polo &mdash; Men&rsquo;s M', sku: 'APP-PLM-004', qty: 12 },
    { nameHtml: 'Insulated Bottle 24 oz', sku: 'DRK-BTL-024', qty: 18 },
  ];

  it('renders the qty column by default', () => {
    const html = itemTable({ items });
    expect(html).toContain('>Qty</td>');
    expect(html).not.toContain('>Status</td>');
    expect(html).toContain('APP-PLM-004');
  });

  it('switches to a per-line status column when any row carries one', () => {
    const html = itemTable({
      items: [
        { ...items[0]!, status: { variant: 'ok', label: 'Delivered' } },
        { ...items[1]!, status: { variant: 'warn', label: 'Backordered' } },
      ],
    });
    expect(html).toContain('>Status</td>');
    expect(html).toContain('class="okpill"');
    expect(html).toContain('class="warnpill"');
    // Qty folds into the item cell.
    expect(html).toContain('&middot; &times;12');
  });

  it('renders the sunk total row when given', () => {
    const html = itemTable({ items, total: { label: 'Total units', valueHtml: '30' } });
    expect(html).toContain('Total units');
    expect(html).toContain(`background:${ES_LIGHT.sunk}`);
  });
});

describe('footer variants', () => {
  const urls = {
    support: 'https://x/support',
    privacy: 'https://x/privacy',
    terms: 'https://x/terms',
    manage: 'https://x/prefs',
    unsubscribe: 'https://x/unsub',
    contact: 'https://x/contact',
    console: 'https://x/console',
    routing: 'https://x/routing',
  };

  it('essential: no unsubscribe, Support/Privacy/Terms, cannot-unsubscribe note', () => {
    const html = footer({ kind: 'ess', reasonHtml: 'Sent to you.', urls });
    expect(html).toContain('>Support</a>');
    expect(html).toContain('>Privacy</a>');
    expect(html).toContain('>Terms</a>');
    expect(html).not.toContain('Unsubscribe</a>');
    expect(html).toContain('can&rsquo;t be unsubscribed');
  });

  it('preference: manage + unsubscribe URLs wired into the links', () => {
    const html = footer({ kind: 'pref', reasonHtml: 'Order updates.', urls });
    expect(html).toContain(`href="${urls.manage}"`);
    expect(html).toContain(`href="${urls.unsubscribe}"`);
    expect(html).toContain('Unsubscribing stops this notification type only');
  });

  it('external: contact-the-sender, no boilerplate note appended', () => {
    const html = footer({ kind: 'ext', reasonHtml: 'No StockPilot account is required.', urls });
    expect(html).toContain('>Contact the sender</a>');
    expect(html).toContain('No StockPilot account is required.</div>');
    expect(html).not.toContain('Unsubscribing');
  });

  it('internal: badge + console links', () => {
    const html = footer({ kind: 'int', reasonHtml: 'Routed to the support queue.', urls });
    expect(html).toContain('Internal support notification');
    expect(html).toContain('>Open support console</a>');
    expect(html).toContain('>Routing rules</a>');
  });

  it('always closes with the mono brand strip', () => {
    for (const kind of ['ess', 'pref', 'ext', 'int'] as const) {
      const html = footer({ kind, reasonHtml: 'r', urls });
      expect(html).toContain('StockPilot &middot; Inventory + Order Mgmt');
      expect(html).toContain('stockpilotusa.com');
    }
  });
});

describe('remaining partials render sane email-safe markup', () => {
  it('eventCard: date rail + details, description omitted in compact form', () => {
    const full = eventCard({
      month: 'Jun',
      day: 11,
      dow: 'Thu',
      titleHtml: 'Cycle count — Aisle 4',
      timeHtml: '9:00 AM – 11:00 AM <span>PT</span>',
      metaHtml: 'DCIV — Fresno · Assigned to Theo Marsh',
      descHtml: 'Full count of bin locations A4-01 through A4-36.',
    });
    expect(full).toContain('role="presentation"');
    expect(full).toContain('>Jun</div>');
    expect(full).toContain('Full count of bin locations');
    const compact = eventCard({
      month: 'Jun',
      day: 11,
      dow: 'Thu',
      titleHtml: 't',
      timeHtml: 'x',
      metaHtml: 'y',
    });
    expect(compact).not.toContain('colspan="2"');
  });

  it('rentalAssetCard: tag header, dashed perforation, 2x2 grid', () => {
    const html = rentalAssetCard({
      nameHtml: 'Handheld Scanner Z-220',
      qty: 2,
      assetTag: 'AST-0142',
      cells: [
        { label: 'Checked out', valueHtml: 'Jun 2, 10:15 AM PT' },
        { label: 'Due back', valueHtml: 'Jun 9, 2026', strong: true },
        { label: 'Borrower', valueHtml: 'Theo Marsh' },
        { label: 'Return to', valueHtml: 'DCIV — Fresno · Equipment cage' },
      ],
    });
    expect(html).toContain('Asset AST-0142');
    expect(html).toContain('&times;2');
    expect(html).toContain('border-bottom:1px dashed rgba(12,12,14,0.22)');
    expect(html).toContain('font-weight:600;color:#0c0c0e;line-height:1.4">Jun 9, 2026');
  });

  it('kpiGrid: pads an odd trailing cell instead of breaking the row', () => {
    const html = kpiGrid([
      { label: 'A', valueHtml: '1', noteHtml: 'a' },
      { label: 'B', valueHtml: '2', noteHtml: 'b' },
      { label: 'C', valueHtml: '3', noteHtml: 'c' },
    ]);
    expect(html.match(/<tr>/g)).toHaveLength(2);
    expect(html).toContain('<td width="50%" style="padding:0 0 0 5px"></td>');
  });

  it('workspaceCard: initials, org identity, role line', () => {
    const html = workspaceCard({
      initials: 'BW',
      orgHtml: 'L4L North Region',
      metaHtml: 'Regional roastery · 3 locations · 7 members',
      roleName: 'Operator',
      roleBlurbHtml: 'can scan, receive, count, and place purchase orders.',
    });
    expect(html).toContain('>BW</div>');
    expect(html).toContain('Your role &middot;');
    expect(html).toContain('>Operator</strong>');
    expect(html).toContain(esAssetUrl('logo-mark-light.png'));
  });

  it('dark mode: default logo renders the light/dark pair with swap classes', () => {
    const html = brandStrip({ tag: 'Security' });
    expect(html).toContain(esAssetUrl('logo-mark-light.png'));
    expect(html).toContain(esAssetUrl('logo-mark-dark.png'));
    expect(html).toContain('class="logo-dark"');
    expect(html).toContain('class="logo-light"');
    // Outlook desktop must never parse the dark copy (it ignores the CSS swap).
    expect(html).toContain('<!--[if !mso]><!-->');
    // The archetype-fidelity escape hatch keeps single-img output.
    const explicit = brandStrip({ tag: 'Security', logoSrc: '{{asset_base}}/logo-mark-light.png' });
    expect(explicit).not.toContain('logo-mark-dark.png');
    // The card variants carry the pair too.
    expect(
      workspaceCard({
        initials: 'BW',
        orgHtml: 'Org',
        metaHtml: 'm',
        roleName: 'Operator',
        roleBlurbHtml: 'b',
      }),
    ).toContain('class="logo-dark"');
    // And the shell's dark blocks flip it (prefers-color-scheme + data-ogsc).
    const shell = emailShell({ title: 't', preheader: 'p', rows: brandStrip({ tag: 'X' }) });
    expect(shell).toContain('.logo-dark{display:inline-block!important}.logo-light{display:none!important}');
    expect(shell).toContain('[data-ogsc] .logo-dark{display:inline-block!important}');
  });

  it('dark mode: text on tonal fills is never repainted by the ink classes', () => {
    // Tonal fills deliberately stay light in dark mode, so their text must
    // keep static dark ink — an .ink/.ink2/.ink3 class here would be
    // repainted light-on-light (illegible denial reasons, KPI stats).
    const b = banner({ tone: 'err', titleHtml: 'Not approved', bodyHtml: 'Reason verbatim.' });
    expect(b).not.toContain('class="ink2"');
    const tonal = kpiGrid([{ label: 'Delivered', valueHtml: '44', noteHtml: 'of 52', tone: 'ok' }]);
    expect(tonal).not.toContain('class="ink"');
    expect(tonal).not.toContain('class="ink3"');
    // Default (paper-backed) KPI cards keep the dark-mode classes.
    const plain = kpiGrid([{ label: 'Orders', valueHtml: '12', noteHtml: 'this week' }]);
    expect(plain).toContain('class="ink"');
    expect(plain).toContain('class="ink3"');
  });

  it('helpRow / previewBanner / internalStrip / banner / detailRows', () => {
    expect(helpRow('New to StockPilot?')).toContain('>?</div>');
    expect(previewBanner()).toContain('Sent only to you — not the scheduled Monday digest.');
    expect(previewBanner()).toContain(`background:${ES_LIGHT.status.purple.bg}`);
    expect(internalStrip()).toContain('Internal support notification — not customer-facing');
    const b = banner({ tone: 'err', titleHtml: 'Not approved', bodyHtml: 'Reason verbatim.' });
    expect(b).toContain(`background:${ES_LIGHT.status.err.bg}`);
    expect(b).toContain(`border:1px solid ${ES_LIGHT.status.err.fg}2e`);
    const rows = detailRows([
      { k: 'Submitter', vHtml: 'Dana Whitfield', strong: true },
      { k: 'Email', vHtml: 'dana@meridiansupply.example' },
    ]);
    expect(rows).toContain('font-weight:600">Dana Whitfield');
    // Last row drops its hairline automatically (row 1 keeps it on both tds).
    expect(rows.match(/border-bottom/g)!.length).toBe(2);
  });

  it('never leaks JS emptiness into markup', () => {
    const samples = [
      eventCard({ month: 'Jun', day: 1, dow: 'Mo', titleHtml: 't', timeHtml: 'x', metaHtml: 'y' }),
      kpiGrid([{ label: 'A', valueHtml: '1', noteHtml: 'a' }]),
      footer({ kind: 'pref', reasonHtml: 'r' }),
      itemTable({ items: [{ nameHtml: 'n', sku: 's', qty: 1 }] }),
    ];
    for (const html of samples) {
      expect(html).not.toMatch(/undefined|\bnull\b|\[object Object\]|NaN/);
    }
  });
});
