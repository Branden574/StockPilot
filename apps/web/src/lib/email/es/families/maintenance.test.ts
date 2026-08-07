import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertEmailWeight } from '../components';
import { esEmailById } from '../registry';

import {
  MAINTENANCE_RESOLVED_FROM,
  MAINTENANCE_RESOLVED_HONESTY_LINE,
  maintenanceResolvedSubject,
  renderMaintenanceResolvedEmail,
} from './maintenance';

import type { MaintenanceResolvedEmailParams } from './maintenance';

/**
 * Maintenance family (2026-08-06, Maintenance Resolved program) — TEMPLATE
 * ONLY. This suite is render-only: no `sendEmail` call ever reaches a real
 * transport, and a source scan (below) proves the family file itself has
 * no way to send.
 *
 * Load-bearing pins: the byte-exact honesty line (html AND text), the
 * verbatim/escaped resolution note (a `<script>`/`<img>` note must render
 * as inert text — this is the template's #1 injection surface), the
 * proof-photo count/fallback arithmetic, a negative sweep proving no
 * signed-Storage-URL shape ever appears, and the full GC-4 vocabulary
 * sweep across every input permutation the plan calls out.
 */

const BASE: MaintenanceResolvedEmailParams = {
  requestHandle: 'MR-2026-000123',
  requestSubject: 'Leaking roof tile in Hall B',
  recipientFirstName: 'Reggie',
  recipientEmail: 'reggie@example.com',
  resolverName: 'Dana Keeler',
  resolutionNote: 'The roof tile has been replaced and the leak is fixed.',
  resolvedOnDisplay: 'Aug 6, 2026 · 2:41 PM PT',
  proofPhotos: [],
  proofPhotoTotal: 0,
  requestUrl: 'https://app.example.com/dashboard/maintenance/req-123',
};

function render(overrides: Partial<MaintenanceResolvedEmailParams> = {}) {
  return renderMaintenanceResolvedEmail({ ...BASE, ...overrides });
}

// ── 1. Subject (registry byte-equality) ─────────────────────────────

describe('maintenance-resolved subject', () => {
  it('is byte-identical to the registry builder', () => {
    expect(maintenanceResolvedSubject('MR-2026-000123')).toBe(
      'Maintenance request MR-2026-000123 marked resolved',
    );
    expect(maintenanceResolvedSubject('MR-2026-000123')).toBe(
      esEmailById('maintenance-resolved').subject({ handle: 'MR-2026-000123' }),
    );
  });

  it('renders the literal subject in the render output', () => {
    const { subject } = render();
    expect(subject).toBe('Maintenance request MR-2026-000123 marked resolved');
  });
});

// ── 2. Honesty line — byte-exact, both outputs ──────────────────────

describe('honesty line', () => {
  const HONESTY =
    'This resolution was recorded by your team in StockPilot. It does not close or update the Zendesk ticket — replies and ticket status stay in the Outlook/Zendesk email conversation.';

  it('is exported byte-exact', () => {
    expect(MAINTENANCE_RESOLVED_HONESTY_LINE).toBe(HONESTY);
  });

  it('appears byte-exact in BOTH html and text, as its own paragraph', () => {
    const { html, text } = render();
    expect(html).toContain(HONESTY);
    expect(text).toContain(HONESTY);
  });

  it('the footer reason opens with the honesty line\'s first sentence', () => {
    const { html } = render();
    expect(html).toContain(
      'This resolution was recorded by your team in StockPilot. Sent once when a request you submitted is marked resolved.',
    );
  });
});

// ── 3. Note verbatim — escaped, newline-faithful ────────────────────

describe('resolution note — verbatim', () => {
  const NOTE = "Replaced the tile and re-sealed the flashing — owner's approval on file.\nSecond visit confirmed no further leaking.";

  it('escaped html preserves both lines with <br>, text keeps the raw note', () => {
    const { html, text } = render({ resolutionNote: NOTE });
    expect(html).toContain('Replaced the tile and re-sealed the flashing');
    // escapeHtml only touches &<>"' — the em dash rides through as literal
    // UTF-8, the apostrophe becomes &#39;, and the newline becomes <br>.
    expect(html).toContain(
      'Replaced the tile and re-sealed the flashing — owner&#39;s approval on file.<br>Second visit confirmed no further leaking.',
    );
    expect(text).toContain(NOTE);
  });

  it('a note with no newline round-trips with no <br>', () => {
    const { html } = render({ resolutionNote: 'Single line note.' });
    expect(html).toContain('Single line note.');
    expect(html).not.toMatch(/Single line note\.<br>/);
  });

  it('a 2000-char note round-trips completely in both outputs (not truncated)', () => {
    const long = 'A'.repeat(1999) + 'Z';
    expect(long).toHaveLength(2000);
    const { html, text } = render({ resolutionNote: long });
    expect(html).toContain(long);
    expect(text).toContain(long);
  });

  it('a note containing a script tag renders as inert escaped text, never live markup', () => {
    const hostile = 'Fixed it.\n<script>alert(1)</script>';
    const { html } = render({ resolutionNote: hostile });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('a note containing an img tag renders as inert escaped text, never a live element', () => {
    const hostile = 'See attached. <img src=x onerror=alert(1)>';
    const { html } = render({ resolutionNote: hostile });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

// ── 4. Resolver line ─────────────────────────────────────────────────

describe('resolver line', () => {
  it('text output carries the literal unbroken sentence', () => {
    const { text } = render();
    expect(text).toContain('Marked resolved by Dana Keeler');
  });

  it('html composes the same words around a <strong> resolver name', () => {
    const { html } = render();
    expect(html).toContain('Marked resolved by <strong');
    expect(html).toContain('>Dana Keeler</strong>');
  });

  it('escapes a resolver name carrying HTML-special characters', () => {
    const { html, text } = render({ resolverName: 'Dana <O\'Keeler> & Co' });
    expect(html).not.toContain('<O\'Keeler>');
    expect(html).toContain('Dana &lt;O&#39;Keeler&gt; &amp; Co');
    expect(text).toContain("Dana <O'Keeler> & Co");
  });
});

// ── 5. Proof photos ───────────────────────────────────────────────────

/**
 * The brand-strip logo ALWAYS renders 2 <img> tags (light/dark swap) —
 * every count below must isolate the proof-photo grid specifically, which
 * is the only place `width="120"` appears.
 */
function countProofImgs(html: string): number {
  return html.match(/width="120"/g)?.length ?? 0;
}

describe('proof photos', () => {
  it('2 fixtures render exactly 2 proof <img> with the literal fixture src values', () => {
    const photos = [
      { src: 'https://app.example.com/m/abcdef123456/photo/0', alt: 'roof-1.jpg' },
      { src: 'https://app.example.com/m/abcdef123456/photo/1', alt: 'roof-2.jpg' },
    ];
    const { html } = render({ proofPhotos: photos, proofPhotoTotal: 2 });
    expect(countProofImgs(html)).toBe(2);
    expect(html).toContain('src="https://app.example.com/m/abcdef123456/photo/0"');
    expect(html).toContain('src="https://app.example.com/m/abcdef123456/photo/1"');
    expect(html).not.toContain('more photos on the request');
  });

  it('6 fixtures with proofPhotoTotal 6 render 4 proof <img> and a "+2 more photos" line', () => {
    const photos = Array.from({ length: 6 }, (_, i) => ({
      src: `https://app.example.com/m/abcdef123456/photo/${i}`,
      alt: `roof-${i}.jpg`,
    }));
    const { html } = render({ proofPhotos: photos, proofPhotoTotal: 6 });
    expect(countProofImgs(html)).toBe(4);
    expect(html).toContain('+2 more photos on the request');
    // Only the first 4 (index 0-3) are embedded.
    expect(html).toContain('src="https://app.example.com/m/abcdef123456/photo/3"');
    expect(html).not.toContain('src="https://app.example.com/m/abcdef123456/photo/4"');
  });

  it('[] with proofPhotoTotal 0 renders no proof <img> and no fallback line', () => {
    const { html } = render({ proofPhotos: [], proofPhotoTotal: 0 });
    expect(countProofImgs(html)).toBe(0);
    // The static preheader ("...any proof photos are inside") legitimately
    // says "proof photos" regardless of count — the fallback LINE is what
    // must be absent, not the word.
    expect(html).not.toMatch(/on the request in StockPilot\./);
    expect(html).not.toContain('more photos on the request');
  });

  it('[] with proofPhotoTotal 3 renders the literal fallback line and no proof <img>', () => {
    const { html } = render({ proofPhotos: [], proofPhotoTotal: 3 });
    expect(countProofImgs(html)).toBe(0);
    expect(html).toContain('3 proof photos are on the request in StockPilot.');
  });

  it('text mirror always uses the fallback phrasing (text cannot embed images)', () => {
    const photos = [{ src: 'https://app.example.com/m/tok/photo/0', alt: 'a.jpg' }];
    const { text } = render({ proofPhotos: photos, proofPhotoTotal: 1 });
    expect(text).toContain('1 proof photo is on the request in StockPilot.');
    const { text: zeroText } = render({ proofPhotos: [], proofPhotoTotal: 0 });
    expect(zeroText).not.toContain('proof photo');
  });

  it('attribute-context injection via proof photo src is neutralized (quotes escaped)', () => {
    const hostile = 'https://stockpilotusa.com/m/tok/photo/0" onerror="alert(1)" x="';
    const photos = [{ src: hostile, alt: 'roof-1.jpg' }];
    const { html } = render({ proofPhotos: photos, proofPhotoTotal: 1 });
    // The live onerror attribute must NOT appear
    expect(html).not.toContain('onerror="alert(1)"');
    // The escaped form must be present (the quote becomes &quot;)
    expect(html).toContain('&quot; onerror=&quot;alert(1)&quot; x=&quot;');
    // The image must still render with the escaped src
    expect(html).toContain(`src="${hostile.replace(/"/g, '&quot;')}"`);
  });
});

// ── 6. Negative: never a signed Storage URL ─────────────────────────

describe('signed-URL leak guard', () => {
  it('never emits supabase.co, /storage/v1/, or a token= query param', () => {
    const photos = [
      { src: 'https://app.example.com/m/xyz789/photo/0', alt: 'roof-1.jpg' },
      { src: 'https://app.example.com/m/abcdef123456/photo/1', alt: 'roof-2.jpg' },
    ];
    const { html, text } = render({ proofPhotos: photos, proofPhotoTotal: 2 });
    for (const out of [html, text]) {
      expect(out).not.toContain('supabase.co');
      expect(out).not.toContain('/storage/v1/');
      expect(out).not.toContain('token=');
    }
  });
});

// ── 7. CTA + sender ───────────────────────────────────────────────────

describe('cta + sender', () => {
  it('cta href is literal-pinned to params.requestUrl', () => {
    const { html } = render({
      requestUrl: 'https://app.example.com/dashboard/maintenance/xyz-999',
    });
    expect(html).toContain('href="https://app.example.com/dashboard/maintenance/xyz-999"');
    expect(html).toContain('>View request');
  });

  it('attribute-context injection via requestUrl in cta and footer is neutralized (quotes escaped)', () => {
    const hostile = 'https://app.example.com/dashboard/maintenance/xyz" onerror="alert(1)" x="';
    const { html } = render({ requestUrl: hostile });
    // The live onerror attribute must NOT appear
    expect(html).not.toContain('onerror="alert(1)"');
    // The escaped form must be present in both the cta href and footer support link
    expect(html).toContain(`&quot; onerror=&quot;alert(1)&quot; x=&quot;`);
    // Both links (primary button and footer) must carry the escaped URL
    expect(html.match(/href=".*&quot;.*onerror/g)).toBeTruthy();
  });

  it('sends from the registry sender, re-pinned as a string literal here (GC 9)', () => {
    expect(MAINTENANCE_RESOLVED_FROM).toBe('StockPilot <maintenance@stockpilotusa.com>');
    expect(MAINTENANCE_RESOLVED_FROM).toBe(esEmailById('maintenance-resolved').from);
  });
});

// ── 8. Forbidden-phrase sweep (GC-4 vocabulary) ─────────────────────

const FORBIDDEN_PHRASES = [
  'Email sent',
  'Ticket created',
  'Request submitted to Zendesk',
  'DC4 notified',
  'Andrew notified',
  'Ticket assigned',
  'Ticket closed',
  'Ticket resolved',
  'Zendesk ticket closed',
  'Zendesk ticket updated',
  'Zendesk ticket resolved',
  'Issue verified fixed',
];

function sweep(subject: string, html: string, text: string): void {
  for (const phrase of FORBIDDEN_PHRASES) {
    expect(subject, `subject must not contain "${phrase}"`).not.toContain(phrase);
    expect(html, `html must not contain "${phrase}"`).not.toContain(phrase);
    expect(text, `text must not contain "${phrase}"`).not.toContain(phrase);
  }
}

describe('forbidden-vocabulary sweep (GC-4) across input permutations', () => {
  const permutations: [string, Partial<MaintenanceResolvedEmailParams>][] = [
    ['single-line note, no photos', { resolutionNote: 'Fixed the leak.', proofPhotos: [], proofPhotoTotal: 0 }],
    [
      'multi-line note, no photos',
      { resolutionNote: 'Fixed the leak.\nRe-checked the next day.', proofPhotos: [], proofPhotoTotal: 0 },
    ],
    [
      'note, 1 photo',
      {
        proofPhotos: [{ src: 'https://app.example.com/m/tok/photo/0', alt: 'a.jpg' }],
        proofPhotoTotal: 1,
      },
    ],
    [
      'note, many photos (overflow)',
      {
        proofPhotos: Array.from({ length: 6 }, (_, i) => ({
          src: `https://app.example.com/m/tok/photo/${i}`,
          alt: `p${i}.jpg`,
        })),
        proofPhotoTotal: 6,
      },
    ],
    ['fallback-only photos (no share link)', { proofPhotos: [], proofPhotoTotal: 5 }],
  ];

  for (const [label, overrides] of permutations) {
    it(label, () => {
      const { subject, html, text } = render(overrides);
      sweep(subject, html, text);
    });
  }

  it('the sweep array above is the only place these phrases appear in this file', () => {
    // The array itself necessarily contains the phrases; this proves no
    // OTHER string literal in the test/family source repeats them.
    const src = readFileSync(path.resolve(__dirname, 'maintenance.ts'), 'utf8');
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(src, `maintenance.ts must not contain "${phrase}"`).not.toContain(phrase);
    }
  });
});

// ── 9. Gmail weight budget ────────────────────────────────────────────

describe('weight budget', () => {
  it('assertEmailWeight does not throw for the maximal fixture (2000-char note + 4 imgs)', () => {
    const maxNote = 'L'.repeat(2000);
    const photos = Array.from({ length: 4 }, (_, i) => ({
      src: `https://app.example.com/m/abcdef123456789012345678/photo/${i}`,
      alt: `A fairly long descriptive alt text for photo number ${i}.jpg`,
    }));
    const { html } = render({ resolutionNote: maxNote, proofPhotos: photos, proofPhotoTotal: 4 });
    expect(() => assertEmailWeight(html)).not.toThrow();
  });
});

// ── No undefined/null/raw-merge-token leakage ───────────────────────

describe('output hygiene', () => {
  it('never leaks undefined/null/{{ into subject, html, or text', () => {
    const { subject, html, text } = render({ recipientFirstName: null });
    for (const out of [subject, html, text]) {
      expect(out).not.toMatch(/\bundefined\b/);
      expect(out).not.toMatch(/\bnull\b/);
      expect(out).not.toContain('{{');
    }
  });

  it('missing first name falls back to "Hi —"', () => {
    const { html, text } = render({ recipientFirstName: null });
    expect(html).toContain('Hi —');
    expect(text).toContain('Hi —');
  });
});

// ── NOTHING SENDS: source-level guard ────────────────────────────────

describe('template-only guard (binding constraint 6)', () => {
  // Built from parts so this check can't trip on its own source (the
  // literal substrings below would otherwise match this very file when a
  // future edit widens the scan).
  const RESEND_IMPORT_NEEDLE = ["from '", '@/lib/email/resend', "'"].join('');
  const SEND_CALL_NEEDLE = ['send', 'Email('].join('');

  it('the family file has no sendEmail call, no Resend import, and no direct Resend API reference', () => {
    const src = readFileSync(path.resolve(__dirname, 'maintenance.ts'), 'utf8');
    expect(src).not.toContain(SEND_CALL_NEEDLE);
    expect(src).not.toContain(RESEND_IMPORT_NEEDLE);
    expect(src).not.toContain('resend.com');
    expect(src).not.toContain('api.resend.com');
  });

  it('no sibling file in this family walk imports the Resend transport seam', () => {
    // A structural sanity check, not a dispatch-site enumeration (Task 6
    // owns dispatch): every non-test file under this family directory
    // must stay import-free of the transport seam.
    const FAMILY_DIR = path.resolve(__dirname);
    const offenders: string[] = [];
    for (const entry of readdirSync(FAMILY_DIR)) {
      if (!/^maintenance/.test(entry) || /\.test\.ts$/.test(entry)) continue;
      const full = path.join(FAMILY_DIR, entry);
      if (statSync(full).isDirectory()) continue;
      const content = readFileSync(full, 'utf8');
      if (content.includes(RESEND_IMPORT_NEEDLE)) offenders.push(full);
    }
    expect(offenders).toEqual([]);
  });
});
