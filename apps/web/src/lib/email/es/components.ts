/**
 * StockPilot email system — shared component layer.
 *
 * Every partial returns email-safe HTML strings that reproduce the
 * normative archetype markup at `docs/design/email-system/templates/`
 * pattern-for-pattern: nested `role="presentation"` tables, fully inline
 * styles from tokens, a single 600px column, bulletproof buttons, and
 * the exact mobile / dark media blocks. No flex, no grid, no JS, no
 * shadows inside bodies. Family templates (E3-E7) compose ONLY from
 * these partials — no private one-off UI.
 *
 * Escaping contract: parameters that carry template copy (label / *Html /
 * copy params) are trusted design-package strings and are interpolated
 * raw so entities like `&rsquo;`/`&middot;` survive. Anything derived
 * from user or database input MUST be passed through `escapeHtml()` by
 * the family template before it reaches a partial.
 *
 * Dark mode: the archetypes carry only the `@media (prefers-color-scheme:
 * dark)` block. The binding implementation prompt additionally requires
 * `[data-ogsc]` duplicates for Outlook.com — those are emitted as a
 * separate rule block AFTER the archetype-identical dark block (see
 * ogscBlock). FLAG: the archetype files themselves contain no
 * `[data-ogsc]` rules; the prompt mandates them (IMPLEMENTATION_PROMPT.md
 * "Dark mode" constraint) — implemented as an additive block so the
 * archetype dark block stays byte-equal.
 */

import {
  ES_DARK,
  ES_F1_INLINE,
  ES_LIGHT,
  ES_MAX_HTML_BYTES,
  ES_MONO_INLINE,
  ES_SERIF_INLINE,
  esAssetUrl,
} from './tokens';

import type { EsStatusVariant } from './tokens';

const L = ES_LIGHT;
const D = ES_DARK;

// Softer inner hairline used by the archetype detail grid / list rows.
const HAIR_SOFT = 'rgba(12,12,14,0.08)';

/** Escape a user/database-derived merge value for interpolation into a partial. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

// ── Weight guard ────────────────────────────────────────────────────

/**
 * Guard a rendered email against the Gmail clip limit (~102KB of HTML —
 * past it Gmail truncates the message and hides the unsubscribe footer).
 * Family units call this in their render tests and, defensively, at send
 * time. Throws with the actual size so the offender is obvious.
 */
export function assertEmailWeight(
  html: string,
  limit: number = ES_MAX_HTML_BYTES,
): void {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > limit) {
    throw new Error(
      `[es] email HTML is ${bytes} bytes — over the ${limit}-byte Gmail clip budget`,
    );
  }
}

// ── Style blocks (archetype-exact) ──────────────────────────────────

/**
 * Dark-mode pill override lines, keyed by variant. Values are derived
 * from the dark status pairs in tokens and match the archetype lines
 * byte-for-byte for the variants the archetypes exercise (ok, info, sec).
 */
export const DARK_PILL_OVERRIDES: Record<EsStatusVariant, string> = {
  ok: `.okpill{background:${D.status.ok.bg}!important;color:${D.status.ok.fg}!important}`,
  info: `.infopill{background:${D.status.info.bg}!important;color:${D.status.info.fg}!important}`,
  warn: `.warnpill{background:${D.status.warn.bg}!important;color:${D.status.warn.fg}!important}`,
  err: `.errpill{background:${D.status.err.bg}!important;color:${D.status.err.fg}!important}`,
  neutral: `.neutralpill{background:${D.status.neutral.bg}!important;color:${D.status.neutral.fg}!important}`,
  purple: `.purplepill{background:${D.status.purple.bg}!important;color:${D.status.purple.fg}!important}`,
  sec: `.secpill{color:${D.ink}!important;border-color:${D.status.sec.line}!important}`,
};

/** Mobile extra rules used by the order-status archetype (2-col detail grid stacks). */
export const MOBILE_GRID_RULES = [
  '.grid td{display:block!important;width:100%!important;padding:0 20px 16px!important}',
  '.grid td.first{padding-top:18px!important}',
];

/** Mobile extra rules used by the digest archetype (KPI cards stack). */
export const MOBILE_KPI_RULES = [
  '.kpi td{display:block!important;width:100%!important}',
  '.kpi .cell{margin-bottom:10px!important}',
];

/**
 * Mobile rule for the compact internal headline (support-ticket): the
 * es-support mockup sizes the triage h1 at 23px desktop / 19px mobile —
 * class `h1c` so the archetype `.h1` 24px rule never applies to it.
 */
export const MOBILE_COMPACT_H1_RULES = ['.h1c{font-size:19px!important}'];

export interface EmailShellStyles {
  /**
   * Extra mobile rules inserted between the `.h1` and `.btn` lines —
   * exactly where the archetypes place their per-template rules.
   */
  mobileExtras?: string[];
  /** Pill variants used in this email — emits their dark override lines. */
  darkPills?: EsStatusVariant[];
  /**
   * Selector list for the dark hairline-card override, e.g. `.card`
   * (security) or `.card,.cell` (digest). Omit for none (order-status).
   */
  darkCards?: string;
  /**
   * Emit the dark repaint for the `raise` token (`.raise` class) — the
   * verbatim-message background in the support family. Off by default so
   * the archetype dark blocks stay byte-equal (no archetype uses raise).
   */
  darkRaise?: boolean;
}

function mobileBlock(extras: string[] = []): string {
  const lines = [
    '    .container{width:100%!important}',
    '    .px{padding-left:24px!important;padding-right:24px!important}',
    '    .h1{font-size:24px!important;line-height:1.15!important}',
    ...extras.map((r) => `    ${r}`),
    '    .btn a{display:block!important;text-align:center!important}',
  ];
  return `  @media (max-width:620px){\n${lines.join('\n')}\n  }`;
}

function darkLines(styles: EmailShellStyles): string[] {
  return [
    `body,.desk{background:${D.desk}!important}`,
    `.paper{background:${D.paper}!important}`,
    `.sunk{background:${D.sunk}!important}`,
    ...(styles.darkRaise ? [`.raise{background:${D.raise}!important}`] : []),
    `.ink{color:${D.ink}!important}.ink2{color:${D.ink2}!important}.ink3{color:${D.ink3}!important}.ink4{color:${D.ink4}!important}`,
    ...(styles.darkPills ?? []).map((v) => DARK_PILL_OVERRIDES[v]),
    `.btn td{background:${D.btnBg}!important}.btn a{background:${D.btnBg}!important;color:${D.btnFg}!important}`,
    ...(styles.darkCards ? [`${styles.darkCards}{border-color:${D.hair}!important}`] : []),
  ];
}

function darkBlock(styles: EmailShellStyles): string {
  const lines = darkLines(styles).map((r) => `    ${r}`);
  return `  @media (prefers-color-scheme: dark){\n${lines.join('\n')}\n  }`;
}

/**
 * Outlook.com dark-mode duplicates. Outlook.com rewrites the DOM with a
 * `data-ogsc` attribute instead of honoring `prefers-color-scheme`; the
 * same token repaint is duplicated under `[data-ogsc]` descendant
 * selectors. Additive to the archetype markup (see module header FLAG).
 */
export function ogscBlock(styles: EmailShellStyles): string {
  const lines = darkLines(styles)
    .map((r) =>
      // Prefix every selector in the compound rule lines. Rules are of
      // the form `sel{...}sel{...}` — prefix each `sel{` group. The bare
      // `body` selector is dropped: Outlook.com stamps data-ogsc on
      // elements INSIDE the body, so `[data-ogsc] body` can never match
      // (`.desk` covers the same paint).
      r
        .split(/(?<=})/)
        .filter(Boolean)
        .map((rule) => {
          const brace = rule.indexOf('{');
          const sels = rule
            .slice(0, brace)
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== 'body')
            .map((s) => `[data-ogsc] ${s}`)
            .join(',');
          return `${sels}${rule.slice(brace)}`;
        })
        .join(''),
    )
    .map((r) => `  ${r}`);
  return lines.join('\n');
}

// ── email-shell ─────────────────────────────────────────────────────

export interface EmailShellOptions {
  /** `<title>` text (may contain merge values already escaped). */
  title: string;
  /** Preheader copy — hidden div + `&nbsp;` padding per the archetypes. */
  preheader: string;
  /** Number of trailing `&nbsp;` pads after the preheader (archetypes use 3-8). */
  preheaderPad?: number;
  styles?: EmailShellStyles;
  /**
   * Concatenated `<tr>` rows of the 600px container — brandStrip +
   * sections + footer (plus previewBanner/internalStrip rows where used).
   */
  rows: string;
  lang?: string;
}

/**
 * The document shell: doctype, head (meta + MSO conditional + style
 * block), desk background, hidden preheader, outer centering table and
 * the 600px paper container. Byte-faithful to the archetype skeleton.
 */
export function emailShell({
  title,
  preheader,
  preheaderPad = 6,
  styles = {},
  rows,
  lang = 'en',
}: EmailShellOptions): string {
  const pad = '&nbsp;'.repeat(preheaderPad);
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
<!--[if mso]><style>*{font-family:Helvetica,Arial,sans-serif!important}</style><![endif]-->
<style>
${mobileBlock(styles.mobileExtras)}
${darkBlock(styles)}
${ogscBlock(styles)}
</style>
</head>
<body class="desk" style="margin:0;padding:0;background:${L.desk};font-family:${ES_F1_INLINE};color:${L.ink};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}${pad}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="desk" style="background:${L.desk}">
<tr><td align="center" style="padding:32px 16px">
  <table role="presentation" class="container paper" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${L.paper};border-radius:6px;overflow:hidden">
    ${rows}
  </table>
</td></tr></table>
</body>
</html>`;
}

/** A content row: `<tr><td class="px" style="padding:...">` wrapper. */
export function section(padding: string, innerHtml: string): string {
  return `<tr><td class="px" style="padding:${padding}">
      ${innerHtml}
    </td></tr>`;
}

// ── brand-strip ─────────────────────────────────────────────────────

export interface BrandStripOptions {
  /** Header mono tag, e.g. "Security", "Order Update" (registry `tag`). */
  tag: string;
  logoSrc?: string;
}

export function brandStrip({
  tag,
  logoSrc = esAssetUrl('logo-mark-light.png'),
}: BrandStripOptions): string {
  return `<tr><td class="px" style="padding:20px 36px;border-bottom:1px solid ${L.hair}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle"><img src="${logoSrc}" width="22" height="22" alt="StockPilot" style="display:inline-block;vertical-align:middle;border:0"> <span class="ink" style="font-size:15px;font-weight:600;letter-spacing:-0.025em;color:${L.ink}">Stock<span style="font-weight:500;opacity:0.6">Pilot</span></span></td>
        <td align="right" class="ink4" style="vertical-align:middle;font-family:${ES_MONO_INLINE};font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:${L.ink4}">${tag}</td>
      </tr></table>
    </td></tr>`;
}

// ── status-pill (7 variants) ────────────────────────────────────────

export interface StatusPillOptions {
  variant: EsStatusVariant;
  /** Trusted label HTML (registry copy; may contain `&middot;` etc.). */
  label: string;
  /** Leading dot glyph. On by default; the digest range pill turns it off. */
  dot?: boolean;
}

/**
 * Status pill. Filled variants get a `{variant}pill` class hooked by the
 * dark-mode overrides; the `sec` variant is outlined (transparent bg,
 * hairline ring) per the security archetype.
 */
export function statusPill({ variant, label, dot = true }: StatusPillOptions): string {
  const glyph = dot ? '&#9679; ' : '';
  if (variant === 'sec') {
    return `<div class="secpill" style="display:inline-block;padding:4px 10px;border:1px solid ${L.status.sec.line};border-radius:999px;font-family:${ES_MONO_INLINE};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${L.status.sec.fg};font-weight:600">${glyph}${label}</div>`;
  }
  const c = L.status[variant];
  return `<div class="${variant}pill" style="display:inline-block;padding:4px 10px;background:${c.bg};border-radius:999px;font-family:${ES_MONO_INLINE};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${c.fg};font-weight:600">${glyph}${label}</div>`;
}

// ── headline (+ one-per-email Tinos italic serif turn) ──────────────

export interface HeadlineOptions {
  /** First line (trusted copy). */
  lead: string;
  /**
   * Optional second line — the Tinos italic serif turn. AT MOST ONE
   * serif turn per email (design rule); the headline is its only slot.
   */
  turn?: string;
}

export function headline({ lead, turn }: HeadlineOptions): string {
  const turnHtml = turn
    ? `<br><span class="ink3" style="color:${L.ink3};font-family:${ES_SERIF_INLINE};font-style:italic;font-weight:400">${turn}</span>`
    : '';
  return `<h1 class="h1 ink" style="margin:18px 0 14px;font-size:32px;line-height:1.1;letter-spacing:-0.03em;font-weight:500;color:${L.ink}">${lead}${turnHtml}</h1>`;
}

/** Lead body paragraph under the headline (archetype `<p class="ink2">`). */
export function bodyText(copyHtml: string): string {
  return `<p class="ink2" style="margin:0;font-size:14.5px;line-height:1.55;color:${L.ink2};max-width:480px">${copyHtml}</p>`;
}

/** Standalone mono eyebrow label (digest "Needs action" heading). */
export function eyebrow(label: string): string {
  return `<div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:${L.ink4}">${label}</div>`;
}

export interface CompactHeadlineOptions {
  /** Headline text (family escapes user-derived values). */
  lead: string;
  /** Supporting line under the headline (es-support "{org} · via {source}"). */
  subHtml?: string;
}

/**
 * Compact internal headline — the support-ticket triage h1 from
 * es-support.jsx (23px/600, mobile 19px via MOBILE_COMPACT_H1_RULES).
 * Denser than the 32px hero headline on purpose: triage speed.
 */
export function compactHeadline({ lead, subHtml }: CompactHeadlineOptions): string {
  const sub = subHtml
    ? `\n      <div class="ink3" style="font-size:12.5px;color:${L.ink3}">${subHtml}</div>`
    : '';
  return `<h1 class="h1c ink" style="margin:14px 0 6px;font-size:23px;line-height:1.25;letter-spacing:-0.02em;font-weight:600;color:${L.ink}">${lead}</h1>${sub}`;
}

// ── hero-slot ───────────────────────────────────────────────────────

export interface HeroSlotOptions {
  /** Absolute asset URL (family passes `esAssetUrl('<id>@2x.gif')`). */
  src: string;
  /**
   * Alt text CARRIES THE MESSAGE when images are blocked (MOTION_GLOBAL
   * pattern, e.g. "Route progress: package en route to CVW — Manchester").
   */
  alt: string;
  /** Optional annotation comment rendered before the table (archetype style). */
  note?: string;
}

/**
 * Motion/hero slot: sunk card behind an explicit-dimension image
 * (width=528 height=194 reserves the height for blocked-image clients).
 * One asset max per email, above the fold, never carrying information
 * absent from the text.
 */
export function heroSlot({ src, alt, note }: HeroSlotOptions): string {
  const comment = note ? `<!-- ${note} -->\n      ` : '';
  return `${comment}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="sunk" align="center" style="background:${L.sunk};border:1px solid ${L.hair};border-radius:8px">
          <img src="${src}" width="528" height="194" alt="${alt}" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:8px">
        </td>
      </tr></table>`;
}

// ── bulletproof button / cta-row / link-fallback ────────────────────

export interface ButtonOptions {
  label: string;
  href: string;
  /** Trailing `&rarr;` arrow (all archetype primaries carry it). */
  arrow?: boolean;
}

/** Bulletproof button: bgcolor on the td + fully-styled inline anchor. */
export function button({ label, href, arrow = true }: ButtonOptions): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn"><tr><td bgcolor="${L.btnBg}" style="border-radius:6px;background:${L.btnBg}">
        <a href="${href}" style="display:inline-block;padding:13px 18px;background:${L.btnBg};color:${L.btnFg};border-radius:6px;font-family:${ES_F1_INLINE};font-size:13.5px;font-weight:500;text-decoration:none">${label}${arrow ? ' &rarr;' : ''}</a>
      </td></tr></table>`;
}

export interface CtaRowOptions {
  primary: ButtonOptions;
  /** Optional secondary text link beside the button. */
  secondary?: { label: string; href: string };
  /** Optional supporting note under the buttons (trusted copy). */
  noteHtml?: string;
}

export function ctaRow({ primary, secondary, noteHtml }: CtaRowOptions): string {
  const btn = button(primary);
  const row = secondary
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td>${btn}</td>
        <td style="padding-left:16px"><a class="ink2" href="${secondary.href}" style="font-size:13px;color:${L.ink2};text-decoration:underline">${secondary.label}</a></td>
      </tr></table>`
    : btn;
  const note = noteHtml
    ? `\n      <div class="ink3" style="margin-top:12px;font-size:11.5px;color:${L.ink3};line-height:1.55">${noteHtml}</div>`
    : '';
  return `${row}${note}`;
}

export interface LinkFallbackOptions {
  /**
   * Archetypes disagree: security uses margin-top:12px, order-status
   * (and the mockup layer) 14px. Default 14; security-family passes 12.
   */
  marginTop?: number;
}

/** "Or paste this link into your browser" fallback under a CTA. */
export function linkFallback(url: string, { marginTop = 14 }: LinkFallbackOptions = {}): string {
  return `<div class="ink3" style="margin-top:${marginTop}px;font-size:11.5px;color:${L.ink3};line-height:1.55">Or paste this link into your browser: <span class="ink2" style="font-family:${ES_MONO_INLINE};font-size:10.5px;color:${L.ink2};word-break:break-all">${url}</span></div>`;
}

// ── info-card / generic card ────────────────────────────────────────

/** Generic hairline card wrapper (class `card` hooks the dark border override). */
export function card(innerHtml: string, { pad = '16px 20px' }: { pad?: string } = {}): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px"><tr><td style="padding:${pad}">
        ${innerHtml}
      </td></tr></table>`;
}

export interface InfoCardOptions {
  titleHtml: string;
  bodyHtml: string;
}

/** Titled hairline card (security "Didn't request this?" pattern). */
export function infoCard({ titleHtml, bodyHtml }: InfoCardOptions): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px"><tr><td style="padding:16px 20px">
        <div class="ink" style="font-size:13px;font-weight:600;color:${L.ink};margin-bottom:5px">${titleHtml}</div>
        <div class="ink3" style="font-size:12px;line-height:1.6;color:${L.ink3}">${bodyHtml}</div>
      </td></tr></table>`;
}

// ── detail-grid / detail-row ────────────────────────────────────────

export interface DetailCell {
  label: string;
  valueHtml: string;
  subHtml?: string;
  /** Render the sub line in mono (order-number style) instead of supporting text. */
  subMono?: boolean;
  /** Row-1 cells in the archetype are strong (14px/600); later rows plain (13px ink2). */
  strong?: boolean;
}

function detailCellInner(cell: DetailCell): string {
  const value = cell.strong
    ? `<div class="ink" style="font-size:14px;font-weight:600;color:${L.ink}">${cell.valueHtml}</div>`
    : `<div class="ink2" style="font-size:13px;color:${L.ink2}">${cell.valueHtml}</div>`;
  const sub = cell.subHtml
    ? cell.subMono
      ? `\n            <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:10px;color:${L.ink4};margin-top:3px">${cell.subHtml}</div>`
      : `\n            <div class="ink3" style="font-size:11.5px;color:${L.ink3};margin-top:3px">${cell.subHtml}</div>`
    : '';
  return `<div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:${L.ink4};margin-bottom:5px">${cell.label}</div>
            ${value}${sub}`;
}

export interface DetailGridOptions {
  /** Rows of two cells each — the archetype's 2-up grid (`class="grid"` stacks on mobile). */
  rows: [DetailCell, DetailCell][];
  /** Optional full-width bottom row above a soft hairline (archetype "Approved" row). */
  span?: { label: string; valueHtml: string };
}

export function detailGrid({ rows, span }: DetailGridOptions): string {
  const body = rows
    .map(([a, b], i) => {
      const first = i === 0;
      const tdAttrs = first
        ? ` width="50%" class="first" style="padding:18px 20px 14px;vertical-align:top"`
        : ` style="padding:0 20px 18px;vertical-align:top"`;
      return `<tr>
          <td${tdAttrs}>
            ${detailCellInner(a)}
          </td>
          <td${tdAttrs}>
            ${detailCellInner(b)}
          </td>
        </tr>`;
    })
    .join('\n        ');
  const spanRow = span
    ? `\n        <tr>
          <td colspan="2" style="padding:0 20px 18px;vertical-align:top;border-top:1px solid ${HAIR_SOFT}">
            <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:${L.ink4};margin:14px 0 5px">${span.label}</div>
            <div class="ink2" style="font-size:13px;color:${L.ink2}">${span.valueHtml}</div>
          </td>
        </tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="grid" style="border:1px solid ${L.hair};border-radius:6px">
        ${body}${spanRow}
      </table>`;
}

export interface DetailRowOptions {
  k: string;
  vHtml: string;
  strong?: boolean;
  /** Last row drops its hairline. */
  last?: boolean;
}

/** One key/value line (support-ticket submitter card pattern). Wrap a run of these with `detailRows`. */
export function detailRow({ k, vHtml, strong = false, last = false }: DetailRowOptions): string {
  const border = last ? '' : `border-bottom:1px solid ${L.hair};`;
  return `<tr><td class="ink3" style="padding:9px 0;${border}font-size:12px;color:${L.ink3}">${k}</td><td class="ink" align="right" style="padding:9px 0;${border}font-size:12.5px;color:${L.ink};font-weight:${strong ? 600 : 400}">${vHtml}</td></tr>`;
}

/** Card of key/value rows — the email-safe ESRow stack. */
export function detailRows(rows: DetailRowOptions[], { pad = '8px 20px' }: { pad?: string } = {}): string {
  const body = rows
    .map((r, i) => detailRow({ ...r, last: r.last ?? i === rows.length - 1 }))
    .join('\n          ');
  return card(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${body}
        </table>`,
    { pad },
  );
}

/**
 * Verbatim-message card (es-support "Message — verbatim"): raised panel
 * on the `raise` token behind a customer's exact words. Pair with the
 * shell's `darkRaise` style flag so dark clients repaint the panel.
 */
export function verbatimMessage(bodyHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card raise" style="border:1px solid ${L.hair};border-radius:6px;background:${L.raise}"><tr><td class="ink2" style="padding:14px 16px;font-size:13px;line-height:1.6;color:${L.ink2}">
        ${bodyHtml}
      </td></tr></table>`;
}

// ── item-table (with per-line status column) ────────────────────────

export interface ItemTableRow {
  nameHtml: string;
  sku: string;
  qty: number | string;
  /** Per-line status pill; when any row has one the table shows a Status column. */
  status?: { variant: EsStatusVariant; label: string };
}

export interface ItemTableOptions {
  items: ItemTableRow[];
  /** Optional sunk total row. */
  total?: { label: string; valueHtml: string };
}

const TH_STYLE = `padding:8px 14px;background:${L.sunk};border-bottom:1px solid ${L.hair};font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${L.ink3};font-weight:500`;

export function itemTable({ items, total }: ItemTableOptions): string {
  const withStatus = items.some((it) => it.status);
  const lastCol = withStatus ? 'Status' : 'Qty';
  const lastColWidth = withStatus ? 110 : 44;
  const rows = items
    .map((it, i) => {
      const lastRow = i === items.length - 1 && !total;
      const border = lastRow ? '' : `border-bottom:1px solid ${L.hair};`;
      const qtySuffix = withStatus
        ? ` <span class="ink4" style="color:${L.ink4};font-weight:400">&middot; &times;${it.qty}</span>`
        : '';
      const lastCell = withStatus
        ? it.status
          ? statusPill({ variant: it.status.variant, label: it.status.label, dot: false })
          : ''
        : `<span class="ink" style="font-size:12.5px;font-weight:600;color:${L.ink}">${it.qty}</span>`;
      return `<tr>
          <td style="padding:10px 14px;${border}"><div class="ink" style="font-size:12.5px;color:${L.ink};font-weight:500;line-height:1.3">${it.nameHtml}${qtySuffix}</div></td>
          <td class="ink4" width="110" style="padding:10px 14px;${border}font-family:${ES_MONO_INLINE};font-size:10px;color:${L.ink4}">${it.sku}</td>
          <td align="right" width="${lastColWidth}" style="padding:10px 14px;${border}">${lastCell}</td>
        </tr>`;
    })
    .join('\n        ');
  const totalRow = total
    ? `\n        <tr>
          <td colspan="2" class="sunk ink3" style="padding:10px 14px;background:${L.sunk};font-family:${ES_MONO_INLINE};font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:${L.ink3};font-weight:500">${total.label}</td>
          <td align="right" class="sunk ink" style="padding:10px 14px;background:${L.sunk};font-size:12.5px;font-weight:600;color:${L.ink}">${total.valueHtml}</td>
        </tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px;border-collapse:separate">
        <tr>
          <td class="sunk ink3" style="${TH_STYLE}">Item</td>
          <td class="sunk ink3" width="110" style="${TH_STYLE}">SKU</td>
          <td align="right" class="sunk ink3" width="${lastColWidth}" style="${TH_STYLE}">${lastCol}</td>
        </tr>
        ${rows}${totalRow}
      </table>`;
}

// ── order-timeline ──────────────────────────────────────────────────

export type TimelineState = 'done' | 'current' | 'upcoming' | 'terminal';

export interface TimelineStep {
  label: string;
  state: TimelineState;
}

export interface OrderTimelineOptions {
  /**
   * ONLY the stages that apply to this order's path — the component
   * renders exactly what it is given and never invents stages (denied
   * paths end at a `terminal` "Not approved"; cancelled at "Cancelled").
   */
  steps: TimelineStep[];
  /** Accent for done/current dots (ok/info/warn/neutral per status family). */
  tone?: Exclude<EsStatusVariant, 'sec'>;
}

/** Mono dot timeline (order-status archetype). Terminal steps always use the err accent. */
export function orderTimeline({ steps, tone = 'ok' }: OrderTimelineOptions): string {
  const toneFg = L.status[tone].fg;
  const cells = steps
    .map(({ label, state }) => {
      switch (state) {
        case 'done':
          return `<td align="center" class="ink3" style="color:${L.ink3}">&#9679;<br>${label}</td>`;
        case 'current':
          return `<td align="center" style="color:${toneFg};font-weight:700">&#9679;<br>${label}</td>`;
        case 'terminal':
          return `<td align="center" style="color:${L.status.err.fg};font-weight:700">&#9679;<br>${label}</td>`;
        case 'upcoming':
          return `<td align="center" class="ink4" style="color:${L.ink4}">&#9675;<br>${label}</td>`;
      }
    })
    .join('\n        ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:${ES_MONO_INLINE};font-size:8.5px;letter-spacing:0.08em;text-transform:uppercase"><tr>
        ${cells}
      </tr></table>`;
}

// ── banner ──────────────────────────────────────────────────────────

export interface BannerOptions {
  tone: Exclude<EsStatusVariant, 'sec'>;
  titleHtml?: string;
  bodyHtml?: string;
}

/** Tonal banner (denied reason, portal "How this link works", all-clear). */
export function banner({ tone, titleHtml, bodyHtml }: BannerOptions): string {
  const c = L.status[tone];
  const title = titleHtml
    ? `<div style="font-size:12.5px;font-weight:600;color:${c.fg};margin-bottom:${bodyHtml ? 4 : 0}px">${titleHtml}</div>`
    : '';
  const body = bodyHtml
    ? `${title ? '\n        ' : ''}<div class="ink2" style="font-size:12px;line-height:1.55;color:${L.ink2}">${bodyHtml}</div>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.bg};border:1px solid ${c.fg}2e;border-radius:6px"><tr><td style="padding:14px 16px">
        ${title}${body}
      </td></tr></table>`;
}

// ── event-card ──────────────────────────────────────────────────────

export interface EventCardOptions {
  /** Date rail: "Jun" / 11 / "Thu". */
  month: string;
  day: string | number;
  dow: string;
  titleHtml: string;
  timeHtml: string;
  metaHtml: string;
  /** Omitted in the compact (1-hour) variant. */
  descHtml?: string;
}

/** Schedule event card: sunk date rail + details (+ optional description row). */
export function eventCard({ month, day, dow, titleHtml, timeHtml, metaHtml, descHtml }: EventCardOptions): string {
  const desc = descHtml
    ? `\n        <tr><td colspan="2" class="ink3" style="padding:12px 18px;border-top:1px solid ${L.hair};font-size:12px;line-height:1.55;color:${L.ink3}">${descHtml}</td></tr>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px">
        <tr>
          <td class="sunk" width="72" align="center" style="background:${L.sunk};border-right:1px solid ${L.hair};padding:16px 0;vertical-align:middle">
            <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:${L.ink4}">${month}</div>
            <div class="ink" style="font-size:26px;font-weight:600;letter-spacing:-0.02em;color:${L.ink};line-height:1.1">${day}</div>
            <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:${L.ink4}">${dow}</div>
          </td>
          <td style="padding:14px 18px;vertical-align:middle">
            <div class="ink" style="font-size:14.5px;font-weight:600;color:${L.ink};line-height:1.3">${titleHtml}</div>
            <div class="ink2" style="font-size:12px;color:${L.ink2};margin-top:4px">${timeHtml}</div>
            <div class="ink3" style="font-size:11.5px;color:${L.ink3};margin-top:2px">${metaHtml}</div>
          </td>
        </tr>${desc}
      </table>`;
}

// ── rental-asset-card ───────────────────────────────────────────────

export interface RentalAssetCardOptions {
  nameHtml: string;
  qty: number | string;
  assetTag: string;
  /** 2×2 grid under the perforation: e.g. Checked out / Due back / Borrower / Return to. */
  cells: { label: string; valueHtml: string; strong?: boolean }[];
  /** Optional 40px icon slot HTML (an <img>); empty sunk box by default. */
  iconHtml?: string;
}

/** Purpose-built rental asset card — tag header + dashed perforation + detail grid. */
export function rentalAssetCard({ nameHtml, qty, assetTag, cells, iconHtml }: RentalAssetCardOptions): string {
  const icon =
    iconHtml ??
    `<div class="sunk" style="width:40px;height:40px;background:${L.sunk};border:1px solid ${L.hair};border-radius:9px;font-size:0;line-height:0">&nbsp;</div>`;
  const gridRows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    const pair = [cells[i], cells[i + 1]].filter(
      (c): c is NonNullable<typeof c> => Boolean(c),
    );
    gridRows.push(
      `<tr>
            ${pair
              .map(
                (c) => `<td width="50%" style="padding:14px 20px 0 0;vertical-align:top">
              <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:${L.ink4};margin-bottom:4px">${c.label}</div>
              <div class="ink" style="font-size:12.5px;font-weight:${c.strong ? 600 : 400};color:${L.ink};line-height:1.4">${c.valueHtml}</div>
            </td>`,
              )
              .join('\n            ')}
          </tr>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px"><tr><td style="padding:18px 20px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px dashed ${L.hair2}"><tr>
          <td width="52" style="padding-bottom:12px;vertical-align:middle">${icon}</td>
          <td style="padding-bottom:12px;vertical-align:middle">
            <div class="ink" style="font-size:14.5px;font-weight:600;color:${L.ink}">${nameHtml} <span class="ink4" style="color:${L.ink4};font-weight:400">&times;${qty}</span></div>
            <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:10px;color:${L.ink4};margin-top:2px">Asset ${assetTag}</div>
          </td>
        </tr></table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${gridRows.join('\n          ')}
        </table>
      </td></tr></table>`;
}

// ── kpi-card / kpi grid ─────────────────────────────────────────────

export interface KpiCardOptions {
  label: string;
  valueHtml: string;
  noteHtml: string;
}

/** One KPI cell (`div.cell` hooks the digest dark/mobile overrides). */
export function kpiCard({ label, valueHtml, noteHtml }: KpiCardOptions): string {
  return `<div class="cell" style="border:1px solid ${L.hair};border-radius:6px;padding:14px 16px">
            <div class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:${L.ink4};margin-bottom:5px">${label}</div>
            <div class="ink" style="font-size:28px;font-weight:600;letter-spacing:-0.02em;color:${L.ink};line-height:1">${valueHtml}</div>
            <div class="ink3" style="font-size:11px;color:${L.ink3};margin-top:4px">${noteHtml}</div>
          </div>`;
}

/** 2-up KPI grid (`class="kpi"` — stacks via MOBILE_KPI_RULES). */
export function kpiGrid(cards: KpiCardOptions[]): string {
  const rows: string[] = [];
  for (let i = 0; i < cards.length; i += 2) {
    const isLastRow = i + 2 >= cards.length;
    const bottom = isLastRow ? '0' : '10px';
    const left = cards[i]!;
    const right = cards[i + 1];
    rows.push(
      `<tr>
          <td width="50%" style="padding:0 5px ${bottom} 0">${kpiCard(left)}</td>
          ${right ? `<td width="50%" style="padding:0 0 ${bottom} 5px">${kpiCard(right)}</td>` : '<td width="50%" style="padding:0 0 0 5px"></td>'}
        </tr>`,
    );
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="kpi">
        ${rows.join('\n        ')}
      </table>`;
}

// ── action-list ─────────────────────────────────────────────────────

export interface ActionListItem {
  tone: Exclude<EsStatusVariant, 'sec'>;
  titleHtml: string;
  detailHtml: string;
}

/** Digest "Needs action" list — tonal dot + title + indented detail per row. */
export function actionList(items: ActionListItem[]): string {
  const rows = items
    .map((a, i) => {
      const last = i === items.length - 1;
      const style = last
        ? 'padding:12px 16px'
        : `padding:12px 16px;border-bottom:1px solid ${HAIR_SOFT}`;
      return `<tr><td style="${style}">
          <span style="color:${L.status[a.tone].fg}">&#9679;</span>&nbsp;&nbsp;<span class="ink" style="font-size:13px;font-weight:600;color:${L.ink}">${a.titleHtml}</span><br>
          <span class="ink3" style="font-size:11.5px;color:${L.ink3};padding-left:18px">${a.detailHtml}</span>
        </td></tr>`;
    })
    .join('\n        ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px">
        ${rows}
      </table>`;
}

// ── schedule-rows ───────────────────────────────────────────────────

export interface ScheduleRowItem {
  /** Left cell — event/work title (12.5px medium ink). */
  titleHtml: string;
  /** Right cell — when/where detail (11.5px ink-3, right-aligned). */
  detailHtml: string;
}

/**
 * The digest "This week" rows card from es-digest.jsx: hairline card of
 * title/detail rows (title carries the weight, detail sits right). The
 * digest archetype omits this section; the mockup is its only source —
 * markup follows the archetype card/row conventions.
 */
export function scheduleRows(items: ScheduleRowItem[]): string {
  const rows = items
    .map((s, i) => {
      const border =
        i === items.length - 1 ? '' : `border-bottom:1px solid ${L.hair};`;
      return `<tr>
          <td class="ink" style="padding:11px 0;${border}font-size:12.5px;font-weight:500;color:${L.ink}">${s.titleHtml}</td>
          <td class="ink3" align="right" style="padding:11px 0;${border}font-size:11.5px;color:${L.ink3};white-space:nowrap">${s.detailHtml}</td>
        </tr>`;
    })
    .join('\n          ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px"><tr><td style="padding:4px 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${rows}
        </table>
      </td></tr></table>`;
}

// ── workspace-card ──────────────────────────────────────────────────

export interface WorkspaceCardOptions {
  /** Inviter initials for the avatar disc. */
  initials: string;
  orgHtml: string;
  /** Meta line: "Regional roastery · 3 locations · 7 members · 3 seats open". */
  metaHtml: string;
  /** Role line: label ("Your role"), name ("Operator"), blurb. */
  roleName: string;
  roleBlurbHtml: string;
  logoSrc?: string;
}

/** Invite workspace card: avatar → workspace mark, org identity, role line. */
export function workspaceCard({
  initials,
  orgHtml,
  metaHtml,
  roleName,
  roleBlurbHtml,
  logoSrc = esAssetUrl('logo-mark-light.png'),
}: WorkspaceCardOptions): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="border:1px solid ${L.hair};border-radius:6px"><tr><td style="padding:18px 20px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="44" style="vertical-align:middle"><div style="width:44px;height:44px;border-radius:50%;background:#c9b184;background-image:linear-gradient(140deg,#d8c9a8 0%,#b89b6a 100%);color:${L.ink};font-family:${ES_F1_INLINE};font-weight:600;font-size:16px;line-height:44px;text-align:center">${initials}</div></td>
          <td width="30" align="center" class="ink4" style="vertical-align:middle;font-family:${ES_MONO_INLINE};font-size:12px;color:${L.ink4}">&rarr;</td>
          <td width="44" style="vertical-align:middle"><div class="sunk" style="width:44px;height:44px;border-radius:10px;background:${L.sunk};border:1px solid ${L.hair};text-align:center;line-height:44px"><img src="${logoSrc}" width="26" height="26" alt="StockPilot" style="display:inline-block;vertical-align:middle;border:0"></div></td>
          <td style="vertical-align:middle;padding-left:14px">
            <div class="ink" style="font-size:14.5px;font-weight:600;color:${L.ink};line-height:1.3">${orgHtml}</div>
            <div class="ink3" style="font-size:11.5px;color:${L.ink3};margin-top:2px">${metaHtml}</div>
          </td>
        </tr></table>
        <div class="ink3" style="margin-top:14px;padding-top:12px;border-top:1px solid ${L.hair};font-size:12px;line-height:1.55;color:${L.ink3}">
          <span class="ink4" style="font-family:${ES_MONO_INLINE};font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${L.ink4};font-weight:500">Your role &middot; </span><strong class="ink" style="font-weight:600;color:${L.ink}">${roleName}</strong> &mdash; ${roleBlurbHtml}
        </div>
      </td></tr></table>`;
}

// ── help-row ────────────────────────────────────────────────────────

/** Serif "?" help row above the footer (invites / portal pattern). */
export function helpRow(bodyHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${L.hair}"><tr>
        <td width="38" style="padding-top:16px;vertical-align:top"><div class="sunk ink3" style="width:26px;height:26px;background:${L.sunk};border:1px solid ${L.hair};border-radius:8px;font-family:${ES_SERIF_INLINE};font-style:italic;font-size:14px;color:${L.ink3};text-align:center;line-height:26px">?</div></td>
        <td class="ink3" style="padding-top:16px;font-size:12px;line-height:1.55;color:${L.ink3}">${bodyHtml}</td>
      </tr></table>`;
}

// ── preview-banner ──────────────────────────────────────────────────

/**
 * Purple digest-preview strip — a full-width container row placed BEFORE
 * the brand strip (digest archetype's commented variant block).
 */
export function previewBanner(
  bodyHtml = `<strong style="color:${L.status.purple.fg}">Preview.</strong> Sent only to you — not the scheduled Monday digest.`,
): string {
  return `<tr><td style="padding:10px 36px;background:${L.status.purple.bg};border-bottom:1px solid ${L.hair}">
      <span style="font-size:11.5px;color:${L.ink2}">${bodyHtml}</span>
    </td></tr>`;
}

// ── internal-strip ──────────────────────────────────────────────────

/** Full-width internal banner row under the brand strip (support-ticket). */
export function internalStrip(
  label = 'Internal support notification — not customer-facing',
): string {
  return `<tr><td class="sunk ink3" style="padding:8px 36px;background:${L.sunk};border-bottom:1px solid ${L.hair};font-family:${ES_MONO_INLINE};font-size:8.5px;letter-spacing:0.2em;text-transform:uppercase;color:${L.ink3};font-weight:600">${label}</td></tr>`;
}

// ── footer ×4 ───────────────────────────────────────────────────────

export type FooterKind = 'ess' | 'pref' | 'ext' | 'int';

/**
 * Category boilerplate appended after the per-email reason. Verbatim
 * from the design package (es-core ES_FOOT_NOTES + archetype footers).
 * FLAG: the digest archetype shortens the pref note to "Unsubscribing
 * stops this notification type only." (archetype-digest.html:118) while
 * the order-status archetype and es-core use the full sentence — the
 * digest family passes `note` explicitly to match its archetype.
 */
export const FOOTER_NOTES: Record<FooterKind, string> = {
  ess: 'Security and account emails are sent whenever this activity happens — they keep your account safe and can&rsquo;t be unsubscribed.',
  pref: 'Unsubscribing stops this notification type only — security and account emails still arrive.',
  ext: '',
  int: '',
};

export interface FooterUrls {
  support?: string;
  privacy?: string;
  terms?: string;
  /** Preference footer: manage-preferences page. */
  manage?: string;
  /** Preference footer: unsubscribe link (also mirrored in List-Unsubscribe headers). */
  unsubscribe?: string;
  /** External footer: contact-the-sender link. */
  contact?: string;
  /** Internal footer links. */
  console?: string;
  routing?: string;
}

export interface FooterOptions {
  kind: FooterKind;
  /** Per-email delivery reason (trusted copy; merge values pre-escaped). */
  reasonHtml: string;
  /** Override the category boilerplate (digest archetype's short note). */
  note?: string;
  urls?: FooterUrls;
}

const FOOTER_LINK_SETS: Record<
  FooterKind,
  { label: string; key: keyof FooterUrls }[]
> = {
  ess: [
    { label: 'Support', key: 'support' },
    { label: 'Privacy', key: 'privacy' },
    { label: 'Terms', key: 'terms' },
  ],
  pref: [
    { label: 'Manage email preferences', key: 'manage' },
    { label: 'Unsubscribe', key: 'unsubscribe' },
    { label: 'Support', key: 'support' },
  ],
  ext: [
    { label: 'Contact the sender', key: 'contact' },
    { label: 'Support', key: 'support' },
    { label: 'Privacy', key: 'privacy' },
  ],
  int: [
    { label: 'Open support console', key: 'console' },
    { label: 'Routing rules', key: 'routing' },
  ],
};

/**
 * Footer row. Four variants:
 *  - `ess`  — essential transactional: no unsubscribe, Support/Privacy/Terms.
 *  - `pref` — preference-controlled: Manage preferences + Unsubscribe + Support
 *             (senders must ALSO set List-Unsubscribe/-Post headers).
 *  - `ext`  — external recipient: explainer reason, Contact the sender.
 *  - `int`  — internal: badge + console links, compact.
 */
export function footer({ kind, reasonHtml, note, urls = {} }: FooterOptions): string {
  const boiler = note ?? FOOTER_NOTES[kind];
  const reason = boiler ? `${reasonHtml} ${boiler}` : reasonHtml;
  const links = FOOTER_LINK_SETS[kind]
    .map(
      ({ label, key }) =>
        `<a class="ink2" href="${urls[key] ?? '#'}" style="color:${L.ink2}">${label}</a>`,
    )
    .join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;');
  const intBadge =
    kind === 'int'
      ? `<div class="ink3" style="display:inline-block;margin-bottom:10px;padding:3px 8px;border:1px solid ${L.hair2};border-radius:4px;font-family:${ES_MONO_INLINE};font-size:8.5px;letter-spacing:0.2em;text-transform:uppercase;color:${L.ink3};font-weight:600">Internal support notification</div>\n      `
      : '';
  return `<tr><td class="px sunk" style="padding:18px 36px;border-top:1px solid ${L.hair};background:${L.sunk}">
      ${intBadge}<div class="ink4" style="font-size:11px;color:${L.ink4};line-height:1.6">${reason}</div>
      <div style="margin-top:8px;font-size:11px">${links}</div>
      <div class="ink4" style="margin-top:10px;padding-top:10px;border-top:1px solid ${L.hair};font-family:${ES_MONO_INLINE};font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:${L.ink4}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="ink4" style="color:${L.ink4}">StockPilot &middot; Inventory + Order Mgmt</td><td align="right" class="ink4" style="color:${L.ink4}">stockpilotusa.com</td></tr></table>
      </div>
    </td></tr>`;
}
