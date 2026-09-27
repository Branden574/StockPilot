'use client';

// The kit card and the Kits row on the New order page. A kit is a bundle whose
// items go into the cart as ordinary lines in one step; the rules (how many
// kits are available, where the units go, all or nothing) are in
// storefront-kits.ts, and this file only draws them.

import { ChevronDown, Layers, Minus, Plus } from 'lucide-react';
import * as React from 'react';

import type { CartKitShares, CatalogItem } from '../v2/types';

import { QtyField, SfPhoto } from './storefront-cards';
import {
  componentAvailable,
  componentItem,
  componentRows,
  kitAvailability,
  kitsInCart,
  maxKits,
  shortComponentNames,
  type KitComponent,
  type KitOffer,
  type KitsResult,
} from './storefront-kits';
import { availableOf } from './storefront-logic';

export interface KitCardProps {
  kit: KitOffer;
  itemMap: ReadonlyMap<string, CatalogItem>;
  qtyByItemId: ReadonlyMap<string, number>;
  /** The units this kit put on each cart line (CartState.kits[bundleId]). */
  shares: CartKitShares | undefined;
  /** Make the kit count in the cart `target` (0 takes the kit out). */
  onSetKits: (kit: KitOffer, target: number) => void;
}

/** "1 kit available" / "60 kits available". */
export function kitsAvailableLabel(kits: number): string {
  return `${kits} ${kits === 1 ? 'kit' : 'kits'} available`;
}

/**
 * The card's line for a kit that cannot be added: every short component, by
 * name. A component with some units, but fewer than one kit needs, says how many.
 */
export function kitShortLabel(
  short: readonly KitComponent[],
  itemMap: ReadonlyMap<string, CatalogItem>,
  nameOf: (component: KitComponent) => string,
): string {
  const parts = short.map((c) => {
    const available = componentAvailable(c, itemMap);
    return available === 0 ? nameOf(c) : `${nameOf(c)} (${available} left, ${c.perKit} per kit)`;
  });
  return `Out of stock: ${parts.join(', ')}`;
}

/** Up to four component photos: one fills the box, more share a 2 x 2 grid. */
function KitMosaic({ photos }: { photos: CatalogItem[] }) {
  if (photos.length <= 1) {
    return photos[0] ? <SfPhoto item={photos[0]} /> : <div className="sf-ph" />;
  }
  return (
    <div className="sf-kit-mosaic" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="cell" key={i}>
          {photos[i] ? <SfPhoto item={photos[i]!} /> : <div className="sf-ph" />}
        </div>
      ))}
    </div>
  );
}

export const KitCard = React.memo(function KitCard({
  kit,
  itemMap,
  qtyByItemId,
  shares,
  onSetKits,
}: KitCardProps) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();

  const availability = kitAvailability(kit, itemMap);
  const inCart = kitsInCart(kit, shares, qtyByItemId);
  const most = maxKits(kit, itemMap, shares, qtyByItemId);
  const out = availability.kits === 0;

  const displayRows = kit.components.map((c) => componentItem(c, itemMap));
  const shortNames = shortComponentNames(displayRows.map((r) => r?.name ?? 'Item'));
  const nameOf = (c: KitComponent) => shortNames[kit.components.indexOf(c)] ?? 'Item';
  const itemList = kit.components
    .map((c, i) => (c.perKit > 1 ? `${shortNames[i]} ×${c.perKit}` : shortNames[i]))
    .join(', ');
  const count = kit.components.length;
  // A photo per component: the first of its rows that has one. It carries the
  // short name, so a component with no photo shows its own letters ("B" for
  // Backpack) rather than the words every name shares.
  const photos = kit.components.slice(0, 4).flatMap((c, i) => {
    const rows = componentRows(c, itemMap);
    const withPhoto = rows.find((r) => r.imageUrl || r.lqip) ?? rows[0];
    return withPhoto ? [{ ...withPhoto, name: shortNames[i] ?? withPhoto.name }] : [];
  });

  let control: React.ReactNode;
  if (inCart === 0) {
    const full = !out && most === 0;
    control = (
      <button
        type="button"
        className={out ? 'sf-add oos' : 'sf-add'}
        disabled={out || full}
        title={full ? 'All available stock is in your cart' : undefined}
        onClick={() => onSetKits(kit, 1)}
        aria-label={`Add kit: ${kit.name}`}
      >
        <Plus size={13} /> Add kit
      </button>
    );
  } else {
    const atMax = inCart >= most;
    control = (
      <div className="sf-step">
        <button
          type="button"
          onClick={() => onSetKits(kit, inCart - 1)}
          aria-label={`One kit less: ${kit.name}`}
        >
          <Minus size={13} />
        </button>
        <QtyField
          itemId={kit.bundleId}
          qty={inCart}
          available={most}
          onSetQty={(_, target) => onSetKits(kit, target)}
          showInCartLabel
          label={`Kits of ${kit.name} in cart`}
        />
        <button
          type="button"
          onClick={() => onSetKits(kit, inCart + 1)}
          disabled={atMax}
          title={atMax ? 'All available stock is in your cart' : 'One kit more'}
          aria-label={`One kit more: ${kit.name}`}
        >
          <Plus size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="sf-card sf-kit-card" data-in-cart={inCart > 0} data-out={out}>
      <div className="sf-ph-box">
        <KitMosaic photos={photos} />
        <span className={out ? 'sf-avail out' : 'sf-avail'}>
          <span className="d" />
          {out ? 'Out of stock' : kitsAvailableLabel(availability.kits)}
        </span>
        <span className="sf-kit-tag">
          <Layers size={11} aria-hidden /> Kit
        </span>
      </div>
      <div className="sf-card-bd">
        <div className="sf-card-nm">{kit.name}</div>
        <div className="sf-kit-items">
          {count} {count === 1 ? 'item' : 'items'}: {itemList}
        </div>
        {/* Static text drawn with the card, so no live region: a status role
            here made every out-of-stock kit an announcement. */}
        {out && (
          <div className="sf-kit-short">{kitShortLabel(availability.short, itemMap, nameOf)}</div>
        )}
        <button
          type="button"
          className="sf-kit-more"
          aria-expanded={open}
          // Only while the details exist: an id with no element is a broken reference.
          aria-controls={open ? detailsId : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          Details <ChevronDown size={12} aria-hidden />
        </button>
        {open && (
          <div className="sf-kit-details" id={detailsId}>
            <ul>
              {kit.components.map((c) => {
                const rows = componentRows(c, itemMap);
                return (
                  <li key={c.anchorItemId}>
                    <span className="nm">
                      {nameOf(c)} ×{c.perKit}
                      {rows.length > 1 ? ` (${rows.length} racks)` : ''}
                    </span>
                    <span className="av">{componentAvailable(c, itemMap)} available</span>
                    {rows.length > 1 && (
                      <span className="racks">
                        {rows
                          .map((r) => `${r.rackLabel ?? 'No rack'} (${availableOf(r)})`)
                          .join(', ')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {!out && count > 1 && availability.limiting && (
              <p className="lim">
                Limited by {nameOf(availability.limiting.component)} (
                {availability.limiting.available})
              </p>
            )}
            <p className="note">
              Each item goes into your cart as its own line, which you can change or remove.
            </p>
          </div>
        )}
        <div className="sf-card-ctl">{control}</div>
      </div>
    </div>
  );
});

/** Kit cards in the card grid, one per kit. */
export function KitGrid({
  kits,
  cartKits,
  ...card
}: Omit<KitCardProps, 'kit' | 'shares'> & {
  kits: readonly KitOffer[];
  cartKits: Readonly<Record<string, CartKitShares>>;
}) {
  return (
    <div className="sf-grid sf-kit-grid">
      {kits.map((kit) => (
        <KitCard key={kit.bundleId} kit={kit} shares={cartKits[kit.bundleId]} {...card} />
      ))}
    </div>
  );
}

/**
 * Around the Kits row: if the kits promise itself rejects in the browser (the
 * loader never rejects, but a stream that breaks mid-page rejects what it has
 * not delivered), or the row fails to draw, the row says the kits could not be
 * loaded instead of taking the order page down with it.
 */
export class KitsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <KitsUnavailable /> : this.props.children;
  }
}

/** Said in place of the Kits row when the kits could not be read. */
export function KitsUnavailable() {
  return (
    <p className="sf-kits-error" role="status">
      Kits could not be loaded. You can still add their items one by one, or reload the page to
      try again.
    </p>
  );
}

const KITS_ROW_SUB = 'Add every item of a kit to your cart in one step';

/**
 * The Kits row's place while the kits stream in, when the Bundles module is on
 * (review F9). The row sits above Frequently ordered and the grid, and it
 * always arrives after the catalog (the loader matches the kits against it), so
 * with no reserved space a late row pushed the grid down under the pointer: a
 * layout shift of 0.078 with the bundles read held 5 s (local, 1440 x 1000).
 * This draws the row's own header and one kit card's box with the same classes,
 * so a row of one line of kits replaces it without moving anything. It has no
 * words of its own: when this person has no kits the row closes up.
 */
export function KitsRowSkeleton() {
  return (
    <section className="sf-kits" aria-busy="true" aria-label="Loading kits">
      {/* The real header's words, invisible, so it wraps exactly as the real
          one does on a narrow screen; only the heading shows, as a bar. */}
      <div className="sf-sec-head sf-kits-sk-head" aria-hidden>
        <h3 className="sf-sk">
          <Layers size={15} /> Kits
        </h3>
        <span className="ct">1</span>
        <span className="sub">{KITS_ROW_SUB}</span>
      </div>
      <div className="sf-grid sf-kit-grid" aria-hidden>
        <div className="sf-card sf-kit-card sf-kit-card-sk">
          <div className="sf-ph-box">
            <div className="sf-sk sf-kit-sk-photo" />
          </div>
          <div className="sf-card-bd">
            <div className="sf-card-nm">
              <span className="sf-sk sf-kit-sk-line" />
            </div>
            <div className="sf-kit-items sf-kit-sk-items">
              <span className="sf-sk sf-kit-sk-line" />
              <span className="sf-sk sf-kit-sk-line short" />
            </div>
            <span className="sf-kit-more sf-kit-sk-more">
              Details <ChevronDown size={12} />
            </span>
            <div className="sf-card-ctl">
              <div className="sf-sk sf-kit-sk-ctl" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The Kits row at the top of the All view, above Frequently ordered. It
 * suspends on the server-started kits promise inside its own boundary (the
 * page gives it KitsRowSkeleton as its fallback when the Bundles module is on),
 * so the catalog grid never waits for it, and it draws nothing when there are
 * no kits. A failed read says so.
 */
export function KitsRow({
  promise,
  ...grid
}: { promise: Promise<KitsResult> } & Omit<React.ComponentProps<typeof KitGrid>, 'kits'>) {
  const result = React.use(promise);
  if (result.status === 'error') return <KitsUnavailable />;
  if (result.kits.length === 0) return null;
  return (
    <section className="sf-kits" aria-label="Kits">
      <div className="sf-sec-head">
        <h3>
          <Layers size={15} /> Kits
        </h3>
        <span className="ct">{result.kits.length}</span>
        <span className="sub">{KITS_ROW_SUB}</span>
      </div>
      <KitGrid kits={result.kits} {...grid} />
    </section>
  );
}
