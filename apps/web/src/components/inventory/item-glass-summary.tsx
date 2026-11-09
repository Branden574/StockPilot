import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { MissingPhoto } from '@/components/patterns/missing-photo';
import { liquidGlassRollout } from '@/components/theme/appearance-flag';
import { formatCurrency, formatNumber } from '@/lib/utils';

import {
  BOOK_REPORT_CARD_DESCRIPTION,
  BOOK_REPORT_TITLE,
  formatStockQuantity,
  ORDER_ITEMS_STATE_EXPECTED_COPY,
  ORDER_ITEMS_STATE_HIDDEN_COPY,
  ORDER_ITEMS_STATE_SHOWN_COPY,
  stockAvailability,
} from '@stockpilot/core';

/**
 * The item and book page's summary card and side column, the way Liquid
 * Glass composes the page (Item-Detail.dc.html, Book-Detail.dc.html; plan
 * 4.6, the slot frame's STATELESS blocks). Words, figures and one link only:
 * no button, field or dialog, so nothing here holds state a switch could lose.
 *
 * EVERY VALUE IS ONE THE PAGE ALREADY HOLDS (plan 4.6 data rule): the item
 * row (`select *`: on hand, reorder point and quantity, retail price, unit
 * cost, status, awaiting first receipt, Staging, order_catalog_visible, the
 * family's group_id, the book's custom fields), the reserved sum the Overview
 * already reads, the photo the Overview already signs, and the context's
 * modules and permissions. Nothing is read for glass. What the boards draw
 * from data the page does not load is not drawn (DECISIONS.md: "drawn
 * elements needing data a page does not load are omitted and recorded"):
 * the size selector (the family's other records), the reorder alert's
 * purchase order, the Reserved card's orders, the Expected card's purchase
 * order, Other editions, the owner charter's name and the Book Order Totals
 * figure (stockpilot-work/liquid-glass/stage3/fidelity-rows.md, lane detail).
 *
 * The classic page keeps its own blocks: the figure strip and the Reorder
 * card carry data-classic-only (hidden in glass), so each figure and the
 * reorder settings are shown once in either design. Both components are
 * glass-only (hidden in Classic by visibility.css; not rendered under the
 * `off` rollout) and listed in tests/e2e/appearance/glass-only-allowlist.json.
 * Styled by styles/liquid-glass/pages/item-detail.css through the inert
 * data-glass hooks below; they carry no Tailwind class, since only glass
 * draws them.
 */

export interface ItemGlassBookFacts {
  /** ISBN as the Details card shows it ('' when none is set). */
  isbn: string;
  author: string | null;
  /** "Grade 3", "Kindergarten" (formatGrade), or null. */
  grade: string | null;
  /** The crate summary the Details card shows (colour label and number). */
  crate: { label: string; hex: string | null; number: string } | null;
  /** The rack label, only when the holdings do not refute it (Details' rule). */
  rack: string | null;
}

export interface ItemGlassFacts {
  isBook: boolean;
  unit: string;
  onHand: number;
  /** Active reservations (the Overview's reservedQuantityByItemIds). */
  reserved: number;
  reorderPoint: number;
  reorderQuantity: number;
  retailPrice: number;
  unitCost: number;
  value: number;
  status: 'active' | 'archived' | 'discontinued';
  awaitingFirstReceipt: boolean;
  /** The row's Staging quantity (the book board's "In Staging" well). */
  staged: number;
  /** A small rendition of the primary photo, or the ISBN cover; null for the hatch. */
  photoSrc: string | null;
  book: ItemGlassBookFacts | null;
  /** The Orders module's visibility state; null when the module is off. */
  ordering: { visible: boolean } | null;
  /** The record belongs to a product family (group_id). */
  inFamily: boolean;
  /** Book Order Totals, for a book, when the viewer may open the report. */
  bookReportHref: string | null;
}

type Tone = 'warn' | 'danger' | null;

/** Low and out of stock by StockStatusBadge's own rule (active, not expected). */
export function stockAlert(f: ItemGlassFacts): 'low' | 'out' | null {
  if (f.status !== 'active' || f.awaitingFirstReceipt) return null;
  if (f.onHand <= 0) return 'out';
  if (f.reorderPoint > 0 && f.onHand <= f.reorderPoint) return 'low';
  return null;
}

function Figure({ value, unit }: { value: string; unit?: string | null }) {
  return (
    <>
      {value}
      {unit ? (
        <>
          {' '}
          <span data-glass-part="unit">{unit}</span>
        </>
      ) : null}
    </>
  );
}

function Well({
  label,
  tone = null,
  wide = false,
  sub,
  children,
}: {
  label: string;
  tone?: Tone;
  /** Two columns wide: a money figure ("$4,160.00") does not fit one 120 px well. */
  wide?: boolean;
  sub?: ReactNode;
  children: ReactNode;
}) {
  // Label first in the DOM, so a screen reader reads "On hand, 6 each"; the
  // stylesheet draws the figure above it, as the board's .stat does.
  return (
    <div
      data-glass-part="well"
      data-glass-tone={tone ?? undefined}
      data-glass-span={wide ? '2' : undefined}
    >
      <dt>{label}</dt>
      <dd>{children}</dd>
      {sub ? <dd data-glass-part="well-sub">{sub}</dd> : null}
    </div>
  );
}

export function ItemGlassSummary({ facts }: { facts: ItemGlassFacts }) {
  if (liquidGlassRollout() === 'off') return null;
  const f = facts;
  const a = stockAvailability({ onHand: f.onHand, reserved: f.reserved });
  const alert = stockAlert(f);
  const onHandTone: Tone = alert === 'out' ? 'danger' : alert === 'low' ? 'warn' : null;
  return (
    <section
      data-glass-only=""
      data-glass="item-summary"
      data-glass-variant={f.isBook ? 'book' : 'item'}
      aria-label={f.isBook ? 'Book summary' : 'Item summary'}
    >
      <div data-glass-part="photo">
        {f.photoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={f.photoSrc}
            alt=""
            // Lazy: Classic never draws this card (display: none), and a lazy
            // image that is not drawn is never fetched, so the classic page
            // asks for no image it did not ask for before.
            loading="lazy"
            decoding="async"
            width={f.isBook ? 152 : 160}
            height={f.isBook ? 228 : 160}
          />
        ) : (
          <MissingPhoto />
        )}
      </div>
      <div data-glass-part="facts">
        {f.book ? (
          <dl data-glass-part="kv">
            {f.book.author ? (
              <>
                <dt>Author</dt>
                <dd>{f.book.author}</dd>
              </>
            ) : null}
            <dt>ISBN</dt>
            <dd data-glass-part={f.book.isbn ? 'mono' : 'muted'}>{f.book.isbn || 'Not set'}</dd>
            {f.book.grade ? (
              <>
                <dt>Grade</dt>
                <dd>{f.book.grade}</dd>
              </>
            ) : null}
            {f.book.crate || f.book.rack ? (
              <>
                <dt>Home crate</dt>
                <dd data-glass-part="crate">
                  {f.book.crate ? (
                    <>
                      <span
                        aria-hidden="true"
                        data-glass-part="crate-dot"
                        style={f.book.crate.hex ? { backgroundColor: f.book.crate.hex } : undefined}
                      />
                      <span>{f.book.crate.label}</span>
                    </>
                  ) : null}
                  {/* The spaces between the parts are real text, for a screen
                      reader; the flex row draws its own 6 px gap. */}
                  {f.book.rack ? (
                    <>
                      {' '}
                      <span>{f.book.crate ? `· Rack ${f.book.rack}` : `Rack ${f.book.rack}`}</span>
                    </>
                  ) : null}{' '}
                  <span data-glass-part="note">(a label only; it does not move stock)</span>
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <dl data-glass-part="wells">
          <Well label="On hand" tone={onHandTone}>
            <Figure value={formatNumber(f.onHand)} unit={f.unit} />
          </Well>
          <Well
            label="Available"
            tone={a.overReserved ? 'danger' : null}
            sub={
              a.overReserved ? (
                <>
                  <AlertTriangle aria-hidden="true" />
                  {formatStockQuantity(a.shortfall)} short of what is promised
                </>
              ) : null
            }
          >
            <Figure value={formatNumber(a.available)} unit={f.unit} />
          </Well>
          <Well label="Reserved">
            <Figure value={formatNumber(a.reserved)} unit={f.unit} />
          </Well>
          {f.isBook ? (
            <Well label="In Staging" tone={f.staged > 0 ? 'warn' : null}>
              <Figure value={formatNumber(f.staged)} unit={f.unit} />
            </Well>
          ) : (
            <Well label="Reorder at">
              <Figure value={formatNumber(f.reorderPoint)} unit={f.unit} />
            </Well>
          )}
          <Well label="Value" wide sub={`@ ${formatCurrency(f.unitCost)} unit cost`}>
            {formatCurrency(f.value)}
          </Well>
        </dl>
        {alert ? (
          <p data-glass-part="alert" data-glass-tone={alert === 'out' ? 'danger' : 'warn'}>
            <AlertTriangle aria-hidden="true" />
            <span>
              {alert === 'out'
                ? 'Out of stock.'
                : `At or below the reorder point of ${formatNumber(f.reorderPoint)} ${f.unit}.`}
              {f.reorderQuantity > 0
                ? ` Reorder quantity: ${formatNumber(f.reorderQuantity)} ${f.unit}.`
                : null}
            </span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function AsideCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-glass="item-aside-card">
      <div data-glass-part="head">
        <h2>{title}</h2>
        {badge}
      </div>
      {children}
    </section>
  );
}

export function ItemGlassAside({ facts }: { facts: ItemGlassFacts }) {
  if (liquidGlassRollout() === 'off') return null;
  const f = facts;
  const a = stockAvailability({ onHand: f.onHand, reserved: f.reserved });
  return (
    <aside
      data-glass-only=""
      data-glass="item-aside"
      aria-label={f.isBook ? 'Book side panel' : 'Item side panel'}
    >
      {f.bookReportHref ? (
        <AsideCard title={BOOK_REPORT_TITLE}>
          <p>{BOOK_REPORT_CARD_DESCRIPTION}</p>
          <p data-glass-part="note">
            Requested through Orders; not copies purchased or current stock.
          </p>
          <Link href={f.bookReportHref} data-glass-part="link-button">
            Open the report
          </Link>
        </AsideCard>
      ) : null}
      {f.ordering ? (
        <AsideCard
          title="Ordering"
          badge={
            // Manage order items' badges (StateBadges): the state, then
            // Expected while the record awaits its first receipt (its
            // `expected` is awaiting_first_receipt, order-catalog-visibility.ts),
            // since Place an Order lists such a record only from that receipt.
            <span data-glass-part="badges">
              <span
                data-glass-part="badge"
                data-glass-tone={f.ordering.visible ? 'accent' : 'neutral'}
              >
                {f.ordering.visible ? ORDER_ITEMS_STATE_SHOWN_COPY : ORDER_ITEMS_STATE_HIDDEN_COPY}
              </span>
              {f.awaitingFirstReceipt ? (
                <span data-glass-part="badge" data-glass-tone="neutral">
                  {ORDER_ITEMS_STATE_EXPECTED_COPY}
                </span>
              ) : null}
            </span>
          }
        >
          <p>
            {!f.ordering.visible
              ? 'Requesters cannot order this record in Place an Order.'
              : f.awaitingFirstReceipt
                ? 'Requesters can order this record in Place an Order from its first receipt, where they are allowed to order.'
                : 'Requesters can order this record in Place an Order where they are allowed to order.'}
          </p>
          <p data-glass-part="note">Hidden items stay in Inventory, existing orders and reports.</p>
        </AsideCard>
      ) : null}
      {a.reserved > 0 || a.overReserved ? (
        <AsideCard title="Reserved">
          <p>
            {formatNumber(a.reserved)} {f.unit} reserved for open orders, so{' '}
            {formatNumber(a.available)} {f.unit} available.
          </p>
          {a.overReserved ? (
            <p data-glass-part="danger">
              {formatStockQuantity(a.shortfall)} short of what is promised.
            </p>
          ) : null}
        </AsideCard>
      ) : null}
      {f.status === 'active' && f.awaitingFirstReceipt ? (
        <AsideCard title="Expected">
          <p>
            Created from a purchase order; nothing has been received yet. It appears everywhere the
            moment the first stock arrives.
          </p>
        </AsideCard>
      ) : null}
      {f.inFamily ? (
        <AsideCard title="Product family">
          <p>
            This record belongs to a product family. Each size is its own record, with its own SKU
            and stock.
          </p>
        </AsideCard>
      ) : null}
      <AsideCard title="Reorder">
        <dl data-glass-part="kv">
          <dt>Reorder at</dt>
          <dd>
            {formatNumber(f.reorderPoint)} {f.unit}
          </dd>
          <dt>Reorder qty</dt>
          <dd>
            {formatNumber(f.reorderQuantity)} {f.unit}
          </dd>
          <dt>Retail price</dt>
          <dd>{formatCurrency(f.retailPrice)}</dd>
          <dt>Status</dt>
          <dd>{f.status.replace(/^./, (s) => s.toUpperCase())}</dd>
        </dl>
      </AsideCard>
    </aside>
  );
}
