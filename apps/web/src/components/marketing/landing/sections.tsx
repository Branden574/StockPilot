/**
 * The post-story sections. All server-rendered — none of this needs JavaScript.
 *
 * Section order is an argument, not a layout: breadth (what the product covers)
 * → depth (what it knows that outsiders do not) → contrast (why not the
 * alternatives) → posture (why you can trust the data layer) → the close.
 *
 * Two constraints shape every section here:
 *  - StockPilot has NO famous customer logos and NO usage metrics, and inventing
 *    them is the one unrecoverable trust error. So credibility is built from
 *    enumerated domain coverage and stated architecture instead.
 *  - Nothing may claim a capability the product does not have. Every line below
 *    is a mechanic that exists in the codebase today.
 */

import { BrandGlyph } from './brand';
import {
  COUNT,
  crateLabel,
  formatSigned,
  isStaleAge,
  PLACED,
  RACK_HOLDING,
  RECEIVED,
  STAGING,
  STALE_ROW,
  VARIANCE,
} from './fixture';
import { APP_ENTRY, SIGN_IN } from './nav';

// ─────────────────────────────────────────────────────────────────────────────
// Module lattice — one hero cell, two promoted, the remainder recedes and crops
// ─────────────────────────────────────────────────────────────────────────────

const SMALL_MODULES = [
  'Transfers',
  'Suppliers',
  'Reporting',
  'Multi-warehouse',
  'Role permissions',
  'Audit history',
  'Barcode scanning',
  'Serial capture',
  'Books',
  'Sports variants',
  'Label printing',
  'CSV + Excel export',
  'REST API',
  'Native iOS app',
];

const STAGE_COLUMNS = [
  {
    k: 'Inbound',
    items: [
      'Purchase orders, draft to received',
      'PO import with duplicate detection',
      'Partial and repeated receipts',
      'Over-receipt recorded, not blocked',
      'Serial numbers captured at receipt',
      'Supplier records and lead times',
    ],
  },
  {
    k: 'Place',
    items: [
      'Staging queue with source and age',
      'Stale-stock flagging',
      'Put-away into a crate on a rack',
      'Bulk placement across a selection',
      'Racks, shelves, bins and sites',
      'Placed versus unplaced, reported apart',
      'Transfers between warehouses',
    ],
  },
  {
    k: 'Count',
    items: [
      'Cycle counts by scope or selection',
      'Variance stamped at count time',
      'Assignee lock, release and reassign',
      'Adjustments posted per variance',
      'Full movement history per item',
    ],
  },
  {
    k: 'Govern',
    items: [
      'Row-level isolation per organization',
      'Per-role and per-user permissions',
      'TOTP two-factor with step-up',
      'Immutable audit trail',
      'New-device sign-in alerts',
    ],
  },
];

export function ModuleLattice() {
  return (
    <section className="lattice" id="modules">
      <div className="wrap">
        <header className="sect-head">
          <p className="eyebrow" data-reveal style={{ '--r': 0 } as React.CSSProperties}>Coverage</p>
          <h2 data-reveal style={{ '--r': 1 } as React.CSSProperties}>Fourteen modules, one ledger.</h2>
          <p className="sect-sub" data-reveal style={{ '--r': 2 } as React.CSSProperties}>
            They are not separate tools that sync overnight. A receipt, a placement
            and a count all write to the same rows, which is why the numbers agree.
          </p>
        </header>

        <div className="lat-grid">
          {/* Hero cell — a real staging queue, not a generic chart. */}
          <article className="lat-cell hero-cell" data-reveal style={{ '--r': 0 } as React.CSSProperties}>
            <h3>Staging</h3>
            <p className="lat-lede">
              Everything received but not yet placed, with the PO that brought it and
              how long it has been sitting.
            </p>
            <ul className="lat-rows">
              {STAGING.slice(0, 4).map((r) => (
                <li key={`${r.sku}-${r.source}`}>
                  <span className="lr-name">{r.title}</span>
                  <span className="lr-meta mono">
                    {r.po ?? '—'} · {r.qty}
                  </span>
                </li>
              ))}
              <li className="lr-flag">
                <span className="lr-name">{STALE_ROW.title}</span>
                <span className="lr-meta mono">
                  {STALE_ROW.ageDays}d
                  {isStaleAge(STALE_ROW.ageDays) ? <span className="stale">Stale</span> : null}
                </span>
              </li>
            </ul>
            <p className="lat-foot mono">{crateLabel(RACK_HOLDING.crate)}</p>
          </article>

          <article className="lat-cell promoted" data-reveal style={{ '--r': 1 } as React.CSSProperties}>
            <h3>Cycle counts</h3>
            <p className="lat-lede">
              Recount against the system. Posting applies the variance on top of
              current stock, so movement during the count is kept.
            </p>
            <div className="lat-figs">
              <span>
                <b className="mono">{COUNT.expected}</b> expected
              </span>
              <span>
                <b className="mono">{COUNT.counted}</b> counted
              </span>
              <span className="alarm-ink">
                <b className="mono">{formatSigned(VARIANCE)}</b> variance
              </span>
            </div>
          </article>

          <article className="lat-cell promoted" data-reveal style={{ '--r': 2 } as React.CSSProperties}>
            <h3>Inventory</h3>
            <p className="lat-lede">
              On hand is the total. Placed is what a picker can actually reach.
              StockPilot reports both, because the gap is where every argument starts.
            </p>
            <div className="lat-figs">
              <span>
                <b className="mono">{RECEIVED}</b> on hand
              </span>
              <span>
                <b className="mono">{PLACED}</b> placed
              </span>
              <span className="warn-ink">
                <b className="mono">{RECEIVED - PLACED}</b> awaiting
              </span>
            </div>
          </article>

          {/* Remainder recedes toward the margins and crops — breadth read as
              texture by peripheral vision, not as fourteen equal cards. */}
          {SMALL_MODULES.map((m, i) => (
            <article
              className="lat-cell small"
              key={m}
              data-reveal
              style={{ '--i': i, '--r': i + 3 } as React.CSSProperties}
            >
              {m}
            </article>
          ))}
        </div>

        <div className="stage-cols">
          {STAGE_COLUMNS.map((c, ci) => (
            <div className="stage-col" key={c.k} data-reveal style={{ '--r': ci } as React.CSSProperties}>
              <p className="sc-k mono">{c.k}</p>
              <ul>
                {c.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage index — the logo wall's replacement
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_COLUMNS = [
  {
    k: 'Receiving',
    items: [
      'Receive in parts against one PO',
      'Over-receipt tolerance recorded',
      'Receipt reversal with mandatory reason',
      'PO import dedupe by file SHA-256',
      'Cancelled POs can be re-imported',
      'Serial capture on the receipt line',
      'Blind receipts without a PO',
      'Bill-to charter held apart from ownership',
      'Supplier lead-time tracking',
      'Expected items hidden until first receipt',
    ],
  },
  {
    k: 'Put-away',
    items: [
      'Crate identity as colour, number, rack, row',
      'A crate sits on a rack, not instead of one',
      'Rack position optional',
      'Label-only crates never erased',
      'Place into the exact crate a book lives in',
      'Bulk placement across a selection',
      'Placement refused across warehouses',
      'Staging age and stale flags',
      'Auto-created staging and unplaced buckets',
      'Site, rack, shelf, bin and vehicle types',
    ],
  },
  {
    k: 'Counting',
    items: [
      'Variance measured at count time',
      'Count scoped to a rack or a selection',
      'Assignee lock prevents takeover',
      'Release and reassign explicitly',
      'Scope-drift warning mid-count',
      'Adjustment posted per variance line',
      'Counted, uncounted and net variance',
      'A pick mid-count is never double-subtracted',
    ],
  },
  {
    k: 'Movement',
    items: [
      'Transfers move only placed stock',
      'Reopening a pick restores the reservation',
      'Pick claim before touching a list',
      'Manual write-off drains shelf before staging',
      'Every movement carries actor and reason',
      'Prior quantity retained on each row',
      'Backorder and partial fulfilment',
      'Archive refuses items still holding stock',
    ],
  },
  {
    k: 'Governance',
    items: [
      'Row-level security per organization',
      'One permission definition drives API, nav and policy',
      'Per-role and per-user grants',
      'TOTP step-up in place, not a sign-out',
      'New-device sign-in alerts',
      'Session revocation across devices',
      'Immutable audit trail',
      'Export to CSV, Excel and PDF',
      'Multi-warehouse access scoping',
      'Auditor read-only preset',
    ],
  },
];

export function CoverageIndex() {
  return (
    <section className="index" id="coverage">
      <div className="wrap">
        <header className="sect-head">
          <p className="eyebrow" data-reveal style={{ '--r': 0 } as React.CSSProperties}>Depth</p>
          <h2 data-reveal style={{ '--r': 1 } as React.CSSProperties}>The part nobody puts on a feature page.</h2>
          <p className="sect-sub" data-reveal style={{ '--r': 2 } as React.CSSProperties}>
            No explanations below. If you run a warehouse you already know which of
            these bit you last quarter.
          </p>
        </header>
        <div className="idx-grid">
          {INDEX_COLUMNS.map((c, ci) => (
            <div className="idx-col" key={c.k} data-reveal style={{ '--r': ci } as React.CSSProperties}>
              <p className="ic-k mono">{c.k}</p>
              <ul>
                {c.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison — categories, never named vendors, with honest concessions
// ─────────────────────────────────────────────────────────────────────────────

type Cell = { s: 'yes' | 'part' | 'no'; note?: string };

const COMPARE: { claim: string; cells: [Cell, Cell, Cell, Cell] }[] = [
  {
    claim: 'Two people counting the same rack cannot overwrite each other',
    cells: [{ s: 'no' }, { s: 'part' }, { s: 'yes' }, { s: 'yes' }],
  },
  {
    claim: 'A receipt over the PO quantity is allowed and recorded, not blocked',
    cells: [{ s: 'yes' }, { s: 'no' }, { s: 'part', note: 'usually a tolerance setting an admin owns' }, { s: 'yes' }],
  },
  {
    claim: 'Stock in a crate that sits on a rack stays findable as both',
    cells: [{ s: 'no' }, { s: 'no' }, { s: 'part' }, { s: 'yes' }],
  },
  {
    claim: 'A pick landing mid-count does not double-subtract the variance',
    cells: [{ s: 'no' }, { s: 'no' }, { s: 'yes' }, { s: 'yes' }],
  },
  {
    claim: 'Reversing a pick restores the reservation, not just the quantity',
    cells: [{ s: 'no' }, { s: 'no' }, { s: 'part' }, { s: 'yes' }],
  },
  {
    claim: 'A cancelled PO can be re-imported without a duplicate-key failure',
    cells: [{ s: 'yes' }, { s: 'part' }, { s: 'part' }, { s: 'yes' }],
  },
  {
    claim: 'Anyone can restructure it in ten seconds',
    // An honest concession. Spreadsheets genuinely win this row, and conceding
    // it is what buys credibility for the twelve rows above.
    cells: [{ s: 'yes' }, { s: 'no' }, { s: 'no' }, { s: 'no', note: 'a schema is the point, and the cost' }],
  },
  {
    claim: 'General-ledger integration out of the box',
    cells: [
      { s: 'no' },
      { s: 'part' },
      { s: 'yes', note: 'six-to-nine month implementation; the warehouse team does not own the config' },
      { s: 'part', note: 'CSV kits today, direct connectors in progress' },
    ],
  },
];

const COLS = ['Spreadsheets', 'Generic inventory apps', 'ERP warehouse modules', 'StockPilot'];

export function Comparison() {
  return (
    <section className="compare" id="compare">
      <div className="wrap">
        <header className="sect-head">
          <p className="eyebrow" data-reveal style={{ '--r': 0 } as React.CSSProperties}>Alternatives</p>
          <h2 data-reveal style={{ '--r': 1 } as React.CSSProperties}>Measured against the three things you are probably using.</h2>
          <p className="sect-sub" data-reveal style={{ '--r': 2 } as React.CSSProperties}>
            Categories, not competitors — and two rows we lose, because a comparison
            that sweeps every cell is not a comparison.
          </p>
        </header>

        <div className="cmp-scroll">
          <table className="cmp">
            <thead>
              <tr>
                <th scope="col">
                  <span className="vh">Capability</span>
                </th>
                {COLS.map((c, i) => (
                  <th scope="col" key={c} className={i === 3 ? 'ours' : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((r, ri) => (
                <tr key={r.claim} data-reveal style={{ '--r': ri } as React.CSSProperties}>
                  <th scope="row">{r.claim}</th>
                  {r.cells.map((c, i) => (
                    <td key={i} className={i === 3 ? 'ours' : undefined}>
                      <span className={`mark ${c.s}`}>
                        <span className="mark-dot" aria-hidden />
                        {c.s === 'yes' ? 'Yes' : c.s === 'part' ? 'Partly' : 'No'}
                      </span>
                      {c.note ? <span className="mark-note">{c.note}</span> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Posture — the guarantee we can actually make, and the gap we admit
// ─────────────────────────────────────────────────────────────────────────────

const POSTURE = [
  'Row-level policies live in Postgres, so a query that forgets the organization filter returns nothing rather than everything.',
  'One permission definition drives the API, the navigation and the database policy together — they cannot drift apart.',
  'Privileged actions force a TOTP step-up in place, not a sign-out that loses your work.',
  'Every stock movement writes an immutable row carrying the actor, the reason and the prior quantity.',
];

const SYSTEM_FACTS = [
  { v: 'site · rack · row · crate · book', k: 'Put-away depth', p: 'five levels, each independently queryable' },
  { v: 'Postgres RLS', k: 'Tenant isolation', p: 'enforced by the database, not the app layer' },
  { v: 'TOTP', k: 'Two-factor', p: 'web and native, step-up on privileged actions' },
  { v: 'Every movement', k: 'Audit coverage', p: 'actor, reason and prior quantity retained' },
];

export function PostureBand() {
  return (
    <section className="posture" id="security">
      <div className="wrap">
        <header className="sect-head">
          <p className="eyebrow" data-reveal style={{ '--r': 0 } as React.CSSProperties}>Posture</p>
          <h2 data-reveal style={{ '--r': 1 } as React.CSSProperties}>Isolation is enforced in the database, not in application code.</h2>
        </header>

        <ul className="post-list">
          {POSTURE.map((p, pi) => (
            <li key={p} data-reveal style={{ '--r': pi } as React.CSSProperties}>
              {p}
            </li>
          ))}
        </ul>

        {/* Stating the absence converts a gap into evidence of candour. It is
            also the only honest option, and it is set at the same size as the
            claims above rather than shrunk into a disclaimer. */}
        <p className="post-gap" data-reveal style={{ '--r': 4 } as React.CSSProperties}>
          SOC 2 audit not yet complete. This is the control set already running in
          production.
        </p>

        <dl className="facts">
          {SYSTEM_FACTS.map((f, fi) => (
            <div key={f.k} data-reveal style={{ '--r': fi } as React.CSSProperties}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
              <p className="mono">{f.p}</p>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The close — CTA and footer as ONE object
// ─────────────────────────────────────────────────────────────────────────────

const FOOTER = [
  {
    k: 'Product',
    links: [
      { href: '#flow', label: 'How it works' },
      { href: '#modules', label: 'Modules' },
      { href: '#coverage', label: 'Coverage' },
      { href: '#compare', label: 'Compare' },
      { href: '/pricing', label: 'Pricing' },
    ],
  },
  {
    k: 'Company',
    links: [
      { href: '/contact', label: 'Contact' },
      { href: '/support', label: 'Support' },
      { href: '/security', label: 'Security' },
    ],
  },
  {
    k: 'Legal',
    links: [
      { href: '/terms', label: 'Terms' },
      { href: '/privacy', label: 'Privacy' },
      { href: '/privacy#california', label: 'California notice' },
    ],
  },
];

export function ClosingSlab() {
  return (
    <section className="close" id="cta">
      <div className="wrap">
        <div className="slab">
          <div className="slab-top">
            <div className="slab-say" data-reveal style={{ '--r': 0 } as React.CSSProperties}>
              <p className="eyebrow" data-reveal style={{ '--r': 0 } as React.CSSProperties}>08 · Now</p>
              <h2 data-reveal style={{ '--r': 1 } as React.CSSProperties}>Your inventory is already moving. Start seeing all of it.</h2>
              <ul className="slab-list">
                <li>Every receipt reconciled against its purchase order</li>
                <li>Every unit traceable to a crate on a rack</li>
                <li>Every count that finds a discrepancy, recorded with who found it</li>
              </ul>
            </div>
            <div className="slab-act" data-reveal style={{ '--r': 1 } as React.CSSProperties}>
              <a className="btn primary" href={APP_ENTRY}>
                Open app
              </a>
              <a className="btn ghost" href="/contact">
                Talk to us
              </a>
              <p className="slab-note">
                Already running StockPilot? <a href={SIGN_IN}>Sign in</a>
              </p>
            </div>
          </div>

          <div className="slab-links">
            {FOOTER.map((g, gi) => (
              <div key={g.k} data-reveal style={{ '--r': gi } as React.CSSProperties}>
                <p className="fk mono">{g.k}</p>
                <ul>
                  {g.links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href}>{l.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="slab-brand">
              <span className="ftbrand">
                <BrandGlyph ink />
              </span>
              <p>
                StockPilot is an invite-only inventory system for teams that run a
                physical warehouse.
              </p>
            </div>
          </div>

          <div className="slab-util">
            <span className="mono">
              <span className="live" aria-hidden /> All systems operational
            </span>
            <span className="mono">&copy; {new Date().getFullYear()} StockPilot</span>
          </div>

          {/* Stencilled across the slab the way a company name is painted on a
              warehouse wall: low contrast, a settle rather than a second hero.

              SVG rather than a styled <div> because it has to FIT at every
              viewport. A clamp()-tuned font-size cannot promise that — the
              word's rendered width depends on the loaded face, so it fits at
              the width you tested and overflows at another, which is how this
              ended up sliced mid-letter. `textLength` turns the problem the
              right way round: the word is fitted to the box, rather than the
              box hoping to fit the word. */}
          <svg
            className="stencil"
            viewBox="0 0 1000 152"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden
            focusable="false"
          >
            <text x="0" y="148" textLength="1000" lengthAdjust="spacingAndGlyphs">
              STOCKPILOT
            </text>
          </svg>
        </div>
      </div>
    </section>
  );
}
