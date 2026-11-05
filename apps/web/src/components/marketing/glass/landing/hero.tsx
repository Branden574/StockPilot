import {
  ArrowDown,
  ArrowRight,
  Book,
  Box,
  Check,
  ChevronDown,
  ClipboardCheck,
  House,
  Info,
  Layers,
  Search,
  ShoppingCart,
  Truck,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';

import { buttonClass } from '../ui';

import { AppEntryLink } from './app-entry-link';
import { HERO_ROWS, WORKSPACE } from './data';
import { Badge, Preview, Thumb } from './mock';

/**
 * Landing.dc.html's hero: the pill, the two-line h1, the sub line, Sign in and
 * Explore StockPilot, the invite-only note, and the product window (a sidebar
 * and the Items table over demo data, a receiving toast and an order card
 * floating over its edges). Below 900 px the window gives way to two compact
 * preview cards. The window is one labelled image; no photo is loaded.
 */
export function LandingHero() {
  return (
    <section className="lgl-hero" aria-labelledby="lgl-hero-h">
      <div className="lgs-wrap lgl-hero-grid mx-auto w-full max-w-[1240px] px-5 sm:px-10">
        <div className="lgl-hero-top flex flex-col gap-5">
          <span className="lgl-pill lgs-glass-clear inline-flex w-fit items-center gap-2 text-sm font-semibold">
            <span className="lgl-mint-dot" aria-hidden="true" />
            Inventory and warehouse operations
          </span>
          <h1 className="lgl-h1 text-5xl font-semibold" id="lgl-hero-h">
            Everything in its place. <br />
            <span className="lgl-soft">Every request in view.</span>
          </h1>
          <p className="lgl-sub text-lg">
            Inventory, books, requests, and warehouse work—connected in one place.
          </p>
          <div className="lgl-act flex flex-col gap-3">
            <div className="lgl-cta flex flex-wrap gap-2.5">
              <AppEntryLink where="hero-sign-in" className={buttonClass('primary', 'xl')}>
                Sign in
                <ArrowRight className="size-[18px]" aria-hidden="true" />
              </AppEntryLink>{' '}
              {/* The space the board's markup has between the two buttons: in
                  glass the row is a plain block, as the board's .lp-cta is. */}
              <a href="#story" className={buttonClass('glass', 'xl')}>
                Explore StockPilot
                <ArrowDown className="size-[18px]" aria-hidden="true" />
              </a>
            </div>
            <p className="lgl-hero-note lgs-glass-clear max-w-[460px] text-sm">
              Invite-only. Have an invitation? Open the link in your email. Need access?{' '}
              <Link href="/contact" className="lgs-a underline underline-offset-2">
                Contact the team
              </Link>
              .
            </p>
          </div>
        </div>

        <Preview className="lgl-frame lgs-glass-clear">
          <div className="lgl-window">
            <div className="lgl-mini-sidebar">
              <div className="lgl-ws">
                <span className="lgl-ws-tile">{WORKSPACE.initials}</span>
                <span className="lgl-ws-name">{WORKSPACE.name}</span>
              </div>
              <span className="lgl-nav-item">
                <House />
                Overview
              </span>
              <span className="lgl-nav-sec">Inventory</span>
              <span className="lgl-nav-item lgl-on">
                <Box />
                Items
              </span>
              <span className="lgl-nav-item">
                <Book />
                Books
              </span>
              <span className="lgl-nav-item">
                <Layers />
                Staging<span className="lgl-nav-ct">38</span>
              </span>
              <span className="lgl-nav-item">
                <ClipboardCheck />
                Cycle counts
              </span>
              <span className="lgl-nav-sec">Fulfillment</span>
              <span className="lgl-nav-item">
                <ShoppingCart />
                Orders<span className="lgl-nav-ct lgl-hot">7</span>
              </span>
              <span className="lgl-nav-item">
                <Undo2 />
                Returns<span className="lgl-nav-ct">3</span>
              </span>
            </div>
            <div className="lgl-window-main">
              <div className="lgl-row-jb">
                <div className="lgl-col">
                  <span className="lgl-xs lgl-muted">Inventory</span>
                  <span className="lgl-title">Items</span>
                </div>
                <span className="lgl-demo">
                  <Info />
                  Demo data
                </span>
              </div>
              <div className="lgl-tools">
                <span className="lgl-search">
                  <Search />
                  polo
                </span>
                <span className="lgl-chip lgl-on">
                  <Check />
                  Apparel
                </span>
                <span className="lgl-chip">Low stock</span>
              </div>
              <div className="lgl-table">
                <div className="lgl-tr lgl-th">
                  <span>Item</span>
                  <span>Charter</span>
                  <span>Location</span>
                  <span className="lgl-r">On hand</span>
                  <span className="lgl-r">Available</span>
                </div>
                <div className="lgl-tr lgl-group">
                  <span className="lgl-td-item">
                    <ChevronDown className="lgl-chev" />
                    <b>Staff Polo · Navy</b>
                    <Badge tone="outline">4 linked sizes</Badge>
                  </span>
                  <span className="lgl-ink2">North Campus</span>
                  <span className="lgl-xs lgl-muted">31-C, 32-A</span>
                  <span className="lgl-r lgl-num">82</span>
                  <span className="lgl-r lgl-num">78</span>
                </div>
                {HERO_ROWS.map((row) => (
                  <div key={row.code} className={row.child ? 'lgl-tr lgl-kid' : 'lgl-tr'}>
                    <span className="lgl-td-item">
                      <Thumb kind={row.thumb} size="sm" />
                      <span className="lgl-col">
                        <span className="lgl-clamp">{row.name}</span>
                        <span className="lgl-mono lgl-xs lgl-muted lgl-clamp">{row.code}</span>
                      </span>
                    </span>
                    <span className="lgl-ink2 lgl-clamp">{row.site}</span>
                    <span>
                      <span className={row.staging ? 'lgl-loc lgl-stg' : 'lgl-loc'}>
                        {row.location} <span className="lgl-q">{row.locationQty}</span>
                      </span>
                    </span>
                    <span className={row.low ? 'lgl-r lgl-num lgl-warn' : 'lgl-r lgl-num'}>
                      {row.onHand}
                    </span>
                    <span className="lgl-r">{row.available}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="lgl-toast">
            <Layers className="lgl-ok-ink" />
            PO-000412 · 26 of 30 received → Staging
          </div>
          <div className="lgl-float-card">
            <div className="lgl-row-jb">
              <span className="lgl-mono lgl-strong">SO-000231</span>
              <Badge tone="warn" dot>
                Pending
              </Badge>
            </div>
            <span className="lgl-ink2 lgl-sm">Priya · North Campus</span>
            <span className="lgl-xs lgl-muted lgl-inline">
              <Truck />
              Delivery · 9 lines · needed by Fri, Nov 6
            </span>
            <div className="lgl-two">
              <span className="lgl-fake-btn">Review</span>
              <span className="lgl-fake-btn lgl-primary">
                <Check />
                Approve
              </span>
            </div>
          </div>
        </Preview>

        <Preview className="lgl-prev-mob">
          <div className="lgs-card lgl-mob-card">
            <div className="lgl-row">
              <Thumb kind="shirt" size="lg" />
              <span className="lgl-col lgl-grow">
                <span className="lgl-strong">Staff Polo · Navy</span>
                <span className="lgl-xs lgl-muted">North Campus · 4 linked sizes</span>
              </span>
              <span className="lgl-demo">Demo</span>
            </div>
            <div className="lgl-sizes">
              <span className="lgl-size">
                XS<small>12</small>
              </span>
              <span className="lgl-size">
                S<small>40</small>
              </span>
              <span className="lgl-size lgl-on">
                M<small>6</small>
              </span>
              <span className="lgl-size">
                L<small>24</small>
              </span>
            </div>
            <div className="lgl-row-jb lgl-sm">
              <span className="lgl-row">
                <span className="lgl-loc">
                  31-C <span className="lgl-q">6</span>
                </span>
                <Badge tone="warn">Low</Badge>
              </span>
              <span className="lgl-muted lgl-num">4 available</span>
            </div>
          </div>
          <div className="lgs-card lgl-mob-card">
            <div className="lgl-row-jb">
              <span className="lgl-mono lgl-strong">SO-000231</span>
              <Badge tone="warn" dot>
                Pending
              </Badge>
            </div>
            <span className="lgl-ink2 lgl-sm">North Campus · needed by Fri, Nov 6</span>
            <span className="lgl-fake-btn lgl-primary lgl-lg">Review request</span>
          </div>
        </Preview>
      </div>
    </section>
  );
}
