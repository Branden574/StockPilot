/**
 * The console frame and its seven interiors.
 *
 * This is the redesign's central mechanism: ONE frame that never moves — same
 * border, same corner registration ticks, same header strip, same footer status
 * line — whose *contents* swap as the story advances. A crossfade between whole
 * screenshots would destroy the reader's anchor and force a re-scan at every
 * step; changing the interior of a fixed frame is the only way to express
 * continuity, and continuity of a physical unit through a system is exactly
 * what StockPilot sells.
 *
 * Every surface below mirrors a real app screen — the column headers, badge
 * wording and empty-state copy are lifted verbatim from the components named in
 * each mirror's comment, so a prospect who signs in recognises what they were
 * shown. These are real DOM, not screenshots: selectable, translatable,
 * indexable for the domain vocabulary, crisp at any DPR, and a few kilobytes.
 *
 * Nothing here is interactive. Controls live in page space (segmented control
 * above the frame, stage rail below it) so there is never any ambiguity about
 * what is a marketing affordance and what is product.
 */

import {
  AVAILABLE,
  COUNT,
  crateLabel,
  formatSigned,
  HOLDINGS,
  isStaleAge,
  ON_HAND_AFTER_COUNT,
  ORDERED,
  PO,
  PO_LINES,
  RECEIVED,
  RESERVED,
  STAGING,
  VARIANCE,
  CRATE_COLORS,
  PLACED,
  RACK_HOLDING,
  type StageKey,
} from './fixture';

export type { StageKey };

/** Header strip label per interior — the org and the active view, as the app reads. */
const VIEW_LABEL: Record<StageKey, string> = {
  'purchase-order': 'Purchase orders',
  receive: `Receive ${PO.number}`,
  staging: 'Staging',
  'put-away': 'Place from staging',
  'on-hand': 'Items',
  transfer: 'Pick list',
  count: 'Cycle counts',
};

/**
 * The frame. Geometry is constant across every stage — that is the whole point,
 * so nothing here may depend on `stage` except the header label.
 */
export function ConsoleFrame({
  stage,
  children,
  status,
}: {
  stage: StageKey;
  children: React.ReactNode;
  status?: string;
}) {
  return (
    <div className="console" data-stage={stage}>
      <span className="tick tl" aria-hidden />
      <span className="tick tr" aria-hidden />
      <span className="tick bl" aria-hidden />
      <span className="tick br" aria-hidden />

      <div className="console-head">
        <span className="console-org">DC4 Warehouse</span>
        <span className="console-sep" aria-hidden>
          /
        </span>
        <span className="console-view">{VIEW_LABEL[stage]}</span>
      </div>

      <div className="console-body">{children}</div>

      <div className="console-foot">
        <span className="live" aria-hidden />
        {status ?? 'Last movement 12s ago'}
      </div>
    </div>
  );
}

/** Dot + neutral word. State never becomes a filled colour pill (see P5). */
function State({ label, tone }: { label: string; tone?: 'ok' | 'warn' | 'alarm' }) {
  return (
    <span className={`state${tone ? ` ${tone}` : ''}`}>
      <span className="state-dot" aria-hidden />
      {label}
    </span>
  );
}

function CrateSwatch({ color }: { color: keyof typeof CRATE_COLORS }) {
  // The one licensed use of arbitrary hue on this page: here the colour IS the
  // real-world object, so it carries information rather than decoration.
  return <span className="swatch" style={{ background: CRATE_COLORS[color] }} aria-hidden />;
}

// ── 01 · PURCHASE ORDER ──────────────────────────────────────────────────────
// Mirrors the PO detail "Line items" card — app/(dashboard)/dashboard/
// purchase-orders/[id]/page.tsx:243-249.
export function PurchaseOrderMirror() {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Item</th>
          <th className="num">Ordered</th>
          <th className="num">Received</th>
          <th className="num">Unit cost</th>
        </tr>
      </thead>
      <tbody>
        {PO_LINES.map((l) => (
          <tr key={l.sku}>
            <td>
              <span className={`ttl${l.truncates ? ' trunc' : ''}`}>{l.title}</span>
              <span className="sub mono">{l.sku}</span>
            </td>
            <td className="num mono">{l.ordered}</td>
            <td className="num mono dim">—</td>
            <td className="num mono">${l.unitCost.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>
            <State label="Expected" />
          </td>
          <td className="num mono strong">{ORDERED}</td>
          <td className="num mono dim">—</td>
          <td className="num mono" />
        </tr>
      </tfoot>
    </table>
  );
}

// ── 02 · RECEIVE ─────────────────────────────────────────────────────────────
// Mirrors components/po/po-receive-dialog.tsx:330-386 — the "Received now" /
// "Variance" pair and its helper text, including "{n} over ordered".
export function ReceiveMirror() {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Item</th>
          <th className="num">Ordered</th>
          <th className="num">Received now</th>
          <th className="num">Variance</th>
        </tr>
      </thead>
      <tbody>
        {PO_LINES.map((l) => {
          const v = l.received - l.ordered;
          return (
            <tr key={l.sku} className={v > 0 ? 'flagged' : undefined}>
              <td>
                <span className={`ttl${l.truncates ? ' trunc' : ''}`}>{l.title}</span>
                <span className="sub mono">{l.sku}</span>
              </td>
              <td className="num mono">{l.ordered}</td>
              <td className="num mono strong">{l.received}</td>
              <td className="num mono">
                {v === 0 ? (
                  <span className="dim">Fully received</span>
                ) : v > 0 ? (
                  <span className="alarm-ink">
                    <b>{formatSigned(v)}</b> over ordered
                  </span>
                ) : (
                  <span className="warn-ink">{Math.abs(v)} still to come</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>
            <State label="Partial" tone="warn" />
          </td>
          <td className="num mono">{ORDERED}</td>
          <td className="num mono strong">{RECEIVED}</td>
          <td className="num mono" />
        </tr>
      </tfoot>
    </table>
  );
}

// ── 03 · STAGING ─────────────────────────────────────────────────────────────
// Mirrors components/inventory/staging-table.tsx:527-573. Headers verbatim;
// the `staged`/`unplaced` source badge and the `Stale` age badge are the real
// ones, and `isStaleAge` is the real predicate rather than a re-typed `>`.
export function StagingMirror() {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Item</th>
          <th className="num">Qty to place</th>
          <th>Source PO / receipt</th>
          <th className="num">Age</th>
        </tr>
      </thead>
      <tbody>
        {STAGING.map((r) => (
          <tr key={`${r.sku}-${r.source}`} className={isStaleAge(r.ageDays) ? 'flagged' : undefined}>
            <td>
              <span className={`ttl${r.title.length > 30 ? ' trunc' : ''}`}>{r.title}</span>
              <span className="sub mono">
                {r.sku} <span className={`srcbadge ${r.source}`}>{r.source}</span>
              </span>
            </td>
            <td className="num mono">{r.qty}</td>
            <td className="mono sm">
              {r.po ? (
                <>
                  {r.po} <span className="dim">/ {r.receipt}</span>
                </>
              ) : (
                <span className="dim">—</span>
              )}
            </td>
            <td className="num mono">
              {r.ageDays}d
              {isStaleAge(r.ageDays) ? <span className="stale">Stale</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── 04 · PUT AWAY ────────────────────────────────────────────────────────────
// Mirrors components/inventory/place-from-staging-dialog.tsx + crate-fields.tsx.
// Renders crate identity the way the app does — colour + number + rack + row —
// and includes the rack-NULL holding, because position is genuinely optional.
export function PutAwayMirror() {
  return (
    <div className="place">
      <div className="place-head">
        <span className="lbl">Place into</span>
        <span className="hint">
          The rack and, if it sits in one, the crate on that rack.
        </span>
      </div>
      {HOLDINGS.map((h) => (
        <div className="place-row" key={`${h.sku}-${h.crate.number}`}>
          <div className="place-item">
            <span className="ttl">{h.title}</span>
            <span className="sub mono">{h.sku}</span>
          </div>
          <div className="place-dest">
            <CrateSwatch color={h.crate.color} />
            <span className="mono">{crateLabel(h.crate)}</span>
            {h.crate.rack === null ? <span className="nullrack">rack not set</span> : null}
          </div>
          <div className="place-qty mono">{h.qty}</div>
        </div>
      ))}
      <p className="place-note">
        Identity is colour, number, rack and row — the same crate name legitimately
        exists on more than one rack.
      </p>
    </div>
  );
}

// ── 05 · ON HAND ─────────────────────────────────────────────────────────────
// Mirrors the Items table — components/inventory/inventory-table.tsx:1915-1935
// (book mode: Grade · Rack · Crate) plus the placed / awaiting put-away
// sub-line at :2345-2359.
export function OnHandMirror() {
  const awaiting = RECEIVED - PLACED;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Item</th>
          <th>Charter</th>
          <th>Rack</th>
          <th>Crate</th>
          <th className="num">On hand</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {HOLDINGS.map((h) => (
          <tr key={`${h.sku}-${h.crate.number}`}>
            <td>
              <span className="ttl">{h.title}</span>
              <span className="sub mono">{h.sku}</span>
            </td>
            {/* charter_id IS NULL renders as `Generic` in the real table. */}
            <td>
              <span className="generic">Generic</span>
            </td>
            <td className="mono">
              {h.crate.rack ? `${h.crate.rack}-${h.crate.row}` : <span className="warn-ink">—</span>}
            </td>
            <td className="mono">
              <CrateSwatch color={h.crate.color} />
              {h.crate.number}
            </td>
            <td className="num mono strong">{h.qty}</td>
            <td>
              <State label="In stock" tone="ok" />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={4}>
            <span className="dim">{PLACED} placed</span>
            <span className="warn-ink"> · {awaiting} awaiting put-away</span>
          </td>
          <td className="num mono strong">{RECEIVED}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

// ── 06 · ORDER / TRANSFER ────────────────────────────────────────────────────
export function TransferMirror() {
  return (
    <div className="place">
      <div className="place-head">
        <span className="lbl">Pick list</span>
        <span className="hint">Claimed by A. Rosas · released or reassigned explicitly</span>
      </div>
      <div className="split">
        <div className="split-cell">
          <span className="k">Reserved</span>
          <span className="v mono">{RESERVED}</span>
          <span className="f">held against an open order</span>
        </div>
        <div className="split-cell">
          <span className="k">Available</span>
          <span className="v mono">{AVAILABLE}</span>
          <span className="f">placed stock a picker can reach</span>
        </div>
      </div>
      <p className="place-note">
        A transfer moves only placed stock. Reopening a completed pick restores the
        reservation, not merely the quantity.
      </p>
    </div>
  );
}

// ── 07 · COUNT ───────────────────────────────────────────────────────────────
// Mirrors components/cycle-counts/cycle-count-detail.tsx:352-369 (Item · SKU ·
// Expected · Counted · Variance) and its four stat tiles at :323-332.
export function CountMirror() {
  return (
    <div className="place">
      <div className="statrow">
        {[
          { k: 'Items in scope', v: String(COUNT.itemsInScope) },
          { k: 'Counted', v: String(COUNT.countedLines) },
          { k: 'Uncounted', v: '0' },
          { k: 'Net variance', v: formatSigned(VARIANCE), alarm: true },
        ].map((s) => (
          <div className={`stat${s.alarm ? ' alarm' : ''}`} key={s.k}>
            <span className="k">{s.k}</span>
            <span className="v mono">{s.v}</span>
          </div>
        ))}
      </div>
      <table className="grid tight">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Expected</th>
            <th className="num">Counted</th>
            <th className="num">Variance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="flagged">
            <td>
              <span className="ttl">{RACK_HOLDING.title}</span>
              <span className="sub mono">{COUNT.scope}</span>
            </td>
            <td className="num mono">{COUNT.expected}</td>
            <td className="num mono strong">{COUNT.counted}</td>
            <td className="num mono alarm-ink">{formatSigned(VARIANCE)}</td>
          </tr>
        </tbody>
      </table>
      <p className="place-note">
        Expected is stamped when the line is counted, so a pick landing mid-count is
        kept rather than subtracted twice. Posting brings on hand to{' '}
        <b className="mono">{ON_HAND_AFTER_COUNT}</b>.
      </p>
    </div>
  );
}

/** Interior for a stage. Pure lookup — the frame itself never varies. */
export function StageInterior({ stage }: { stage: StageKey }) {
  switch (stage) {
    case 'purchase-order':
      return <PurchaseOrderMirror />;
    case 'receive':
      return <ReceiveMirror />;
    case 'staging':
      return <StagingMirror />;
    case 'put-away':
      return <PutAwayMirror />;
    case 'on-hand':
      return <OnHandMirror />;
    case 'transfer':
      return <TransferMirror />;
    case 'count':
      return <CountMirror />;
  }
}

