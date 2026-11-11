import { ASSIGNABLE_ROLES, ROLE_LABELS } from '@stockpilot/core';
import {
  BookOpen,
  Box,
  Calendar,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  ClipboardList,
  Download,
  EyeOff,
  History,
  MapPin,
  Minus,
  Network,
  Package,
  PenLine,
  Plus,
  ScanLine,
  Search,
  Send,
  Shield,
  Shirt,
  ShoppingCart,
  Truck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { SiteGlyph } from '../site-brand';
import { buttonClass } from '../ui';

import { AppEntryLink } from './app-entry-link';
import {
  BOOK_TOTALS,
  CHAIN,
  COUNT_LINES,
  FAQ,
  LEDGER,
  ORDER_LINES,
  QUESTIONS,
  REQUESTER_LINK,
  ROLE_TONES,
  SHOP,
  TABLET_ORDERS,
} from './data';
import { Badge, Preview, Thumb } from './mock';

/**
 * The glass landing's sections after the hero (Landing.dc.html): the four
 * questions, How it works, Inventory & books, Orders, Cycle counts, Reports,
 * Web & mobile, Access, Questions and the closing call. Every heading is a
 * real heading in order (h2, then h3 inside a section); every preview is one
 * labelled image over demo data. Recorded deviations: the board's
 * "See a count in the prototype" link is not drawn (there is no prototype on
 * the site); the roles list uses the app's own role names (DECISIONS.md D10);
 * product photos and book covers are tinted tiles.
 */

function SectionHead({
  eyebrow,
  id,
  title,
  lede,
  width,
}: {
  eyebrow: string;
  id: string;
  title: string;
  lede: ReactNode;
  /** The board's max width for a head that spans the section (How it works, Web & mobile). */
  width?: 760 | 780;
}) {
  return (
    <div className={`lgl-text${width ? ` lgl-text-${width}` : ''} flex flex-col gap-3`}>
      <span className="lgs-eyebrow lgs-accent text-xs font-semibold uppercase tracking-[0.06em]">
        {eyebrow}
      </span>
      <h2 className="lgs-h2 text-4xl font-semibold" id={id}>
        {title}
      </h2>
      <p className="lgs-lede text-lg">{lede}</p>
    </div>
  );
}

function Fact({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="lgl-fact">
      <span className="lgl-fi" aria-hidden="true">
        {icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <h3 className="lgl-fact-t font-semibold">{title}</h3>
        <p className="lgl-fact-d text-sm">{children}</p>
      </div>
    </div>
  );
}

const QUESTION_ICON = { box: Box, pin: MapPin, users: Users, history: History } as const;

export function StorySection() {
  return (
    <section
      id="story"
      className="lgs-wrap lgl-story mx-auto w-full max-w-[1240px] px-5 sm:px-10"
      aria-labelledby="lgl-q-h"
    >
      <h2 className="sr-only" id="lgl-q-h">
        The four questions StockPilot answers
      </h2>
      <div className="lgl-questions grid gap-6 md:grid-cols-4">
        {QUESTIONS.map((item) => {
          const Icon = QUESTION_ICON[item.icon];
          return (
            <div key={item.q} className="flex flex-col gap-3">
              <span className="lgl-step-n lgl-q-n" aria-hidden="true">
                <Icon />
              </span>
              <h3 className="lgl-q-t text-xl font-semibold">{item.q}</h3>
              <p className="lgs-ink2 lgl-q-a">{item.a}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function WorkflowSection() {
  return (
    <section id="workflow" className="lgl-sec" aria-labelledby="lgl-wf-h">
      <div className="lgs-wrap mx-auto flex w-full max-w-[1240px] flex-col gap-10 px-5 sm:px-10">
        <SectionHead
          eyebrow="How it works"
          id="lgl-wf-h"
          title="One request, from search to signature."
          lede="Find the stock, ask for it, approve it, hand it over—and keep a record of every unit that moved."
          width={760}
        />
        <div className="lgl-steps grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Step
            n={1}
            title="Find it"
            text="Search by name, SKU, barcode or ISBN and see on hand, available and the exact rack or crate."
          >
            <span className="lgl-search">
              <Search />
              algebra
            </span>
            <span className="lgl-well lgl-row">
              <Thumb kind="book" />
              <span className="lgl-col lgl-grow">
                <b className="lgl-sm">Algebra I · Grade 9</b>
                <span className="lgl-xs lgl-muted">Blue 12 · Rack 4 · Row B</span>
              </span>
              <span className="lgl-num lgl-strong">52</span>
            </span>
            <span className="lgl-well lgl-row">
              <Thumb kind="book" />
              <span className="lgl-col lgl-grow">
                <b className="lgl-sm">Geometry · Grade 10</b>
                <span className="lgl-xs lgl-muted">Green 3 · Rack 4 · Row C</span>
              </span>
              <span className="lgl-num lgl-strong">60</span>
            </span>
          </Step>
          <Step
            n={2}
            title="Request it"
            text="Requesters order from photos, pick a size, and choose pickup or delivery to their site with a needed-by date."
          >
            <span className="lgl-row">
              <Thumb kind="shirt" size="lg" />
              <span className="lgl-col">
                <b className="lgl-sm">Staff Polo · Navy</b>
                <span className="lgl-xs lgl-ok-ink lgl-inline">
                  <CircleCheck />
                  Available: 4
                </span>
              </span>
            </span>
            <span className="lgl-sizes">
              <span className="lgl-size">
                S<small>40</small>
              </span>
              <span className="lgl-size lgl-on">
                M<small>4</small>
              </span>
              <span className="lgl-size">
                L<small>23</small>
              </span>
            </span>
            <span className="lgl-row">
              <span className="lgl-stepper">
                <Minus />
                <output>2</output>
                <Plus />
              </span>
              <span className="lgl-fake-btn lgl-primary lgl-grow">
                <ShoppingCart />
                Add
              </span>
            </span>
          </Step>
          <Step
            n={3}
            title="Approve and fulfill"
            text="Managers approve, the floor picks and stages, and the hand-over is signed for—pickup or delivery."
          >
            {CHAIN.map((step) => (
              <span key={step.label} className={`lgl-chain lgl-${step.state}`}>
                <span className="lgl-chain-dot">
                  {step.state === 'done' ? (
                    <Check />
                  ) : step.state === 'now' ? (
                    <ClipboardList />
                  ) : step.label.startsWith('Delivered') ? (
                    <PenLine />
                  ) : (
                    <Package />
                  )}
                </span>
                <span className="lgl-grow">{step.label}</span>
                <span className="lgl-xs lgl-muted">{step.time}</span>
              </span>
            ))}
          </Step>
          <Step
            n={4}
            title="Keep the record"
            text="Every change lands in an append-only ledger: who, when, how much, and the stock left behind."
          >
            <span className="lgl-xs lgl-strong lgl-muted">Movements · append-only</span>
            {LEDGER.map((entry) => (
              <span key={entry.item} className="lgl-ledger">
                <span className={`lgl-num lgl-strong lgl-${entry.tone}`}>{entry.delta}</span>
                <span className="lgl-grow lgl-clamp">{entry.item}</span>
                <span className="lgl-xs lgl-muted">{entry.who}</span>
              </span>
            ))}
          </Step>
        </div>
      </div>
    </section>
  );
}

function Step({
  n,
  title,
  text,
  children,
}: {
  n: number;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="lgl-step flex flex-col gap-3.5">
      <Preview className="lgs-card lgl-vig">{children}</Preview>
      <div className="flex items-center gap-2.5">
        <span className="lgl-step-n" aria-hidden="true">
          {n}
        </span>
        <h3 className="lgl-step-t text-lg font-semibold">{title}</h3>
      </div>
      <p className="lgs-ink2">{text}</p>
    </div>
  );
}

export function ProductSection() {
  return (
    <section id="product" className="lgl-sec lgl-tight" aria-labelledby="lgl-inv-h">
      <div className="lgs-wrap lgl-split mx-auto grid w-full max-w-[1240px] gap-12 px-5 sm:px-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionHead
            eyebrow="Inventory & books"
            id="lgl-inv-h"
            title="Know what you have—and exactly where it sits."
            lede="On hand is never a guess. StockPilot tracks how much you have and, separately, every rack, crate and staging lane it occupies."
          />
          <div className="lgl-facts">
            <Fact icon={<MapPin />} title="Racks, crates, staging, unplaced">
              Received stock waits in Staging until it is placed. Changing a label never moves
              stock.
            </Fact>
            <Fact icon={<BookOpen />} title="Books by ISBN, grade and crate">
              Editions stay distinct, covers stay visible, and crates are found by color and number.
            </Fact>
            <Fact icon={<Shirt />} title="Sizes that stay separate">
              XS through L are individual records with their own SKU and stock, shown together as
              one family.
            </Fact>
          </div>
        </div>
        <Preview className="lgl-stage lgl-stage-item">
          <div className="lgs-card lgl-item-card">
            <div className="lgl-row">
              <Thumb kind="shirt" size="lg" />
              <span className="lgl-col lgl-grow">
                <span className="lgl-xs lgl-muted">Apparel · North Campus</span>
                <span className="lgl-title">Staff Polo · Navy · M</span>
                <span className="lgl-mono lgl-xs lgl-muted">APP-POLO-NVY-M</span>
              </span>
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
            <div className="lgl-stats">
              <span className="lgl-well lgl-stat">
                <b>6</b>On hand
              </span>
              <span className="lgl-well lgl-stat">
                <b>4</b>Available
              </span>
              <span className="lgl-well lgl-stat">
                <b className="lgl-warn">10</b>Reorder at
              </span>
            </div>
            <div className="lgl-col">
              <span className="lgl-xs lgl-strong lgl-muted">Where it is</span>
              <span className="lgl-row-jb lgl-sm">
                <span className="lgl-loc">
                  31-C <span className="lgl-q">6</span>
                </span>
                <span className="lgl-muted">Main Warehouse · rack</span>
              </span>
              <span className="lgl-row-jb lgl-sm">
                <span className="lgl-loc lgl-stg">
                  Staging <span className="lgl-q">0</span>
                </span>
                <span className="lgl-muted">Nothing waiting to be placed</span>
              </span>
            </div>
          </div>
          {/* The board's three book covers, fanned at the stage's bottom
              right; hidden until the glass CSS shows them (no JavaScript:
              classic CSS). */}
          <span className="lgl-fan hidden">
            {[0, 1, 2].map((cover) => (
              <span key={cover} className="lgl-cover">
                <BookOpen />
              </span>
            ))}
          </span>
        </Preview>
      </div>
    </section>
  );
}

const AVAILABILITY_ICON = { ok: CircleCheck, warn: CircleAlert, muted: CircleX } as const;

export function OrdersSection() {
  return (
    <section className="lgl-sec lgl-tight" aria-labelledby="lgl-ord-h">
      <div className="lgs-wrap lgl-split lgl-rev mx-auto grid w-full max-w-[1240px] gap-12 px-5 sm:px-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionHead
            eyebrow="Orders"
            id="lgl-ord-h"
            title="Requests people can actually place."
            lede="Place an Order works like a storefront for your own stock: photos, sizes, what is available right now, and a cart that tells the truth."
          />
          <div className="lgl-facts">
            <Fact icon={<Truck />} title="Pickup or delivery">
              Deliver to a site, with a needed-by time read in your organization’s time zone.
            </Fact>
            <Fact icon={<EyeOff />} title="Only what should be ordered">
              Managers choose which items appear. Hidden items stay in Inventory, existing orders
              and reports.
            </Fact>
            <Fact icon={<Shield />} title="One press, one order">
              A lost connection never places a request twice, and a refusal says exactly what to
              fix.
            </Fact>
          </div>
        </div>
        <Preview className="lgl-stage">
          <div className="lgs-card lgl-shop">
            <div className="lgl-row-jb">
              <span className="lgl-title-sm">Place an order</span>
              <span className="lgl-steps-mini">
                <span className="lgl-done">✓ Browse</span>
                <span className="lgl-now">2 Cart</span>
                <span>3 Review</span>
              </span>
            </div>
            <div className="lgl-shop-grid">
              {SHOP.map((product) => {
                const Icon = AVAILABILITY_ICON[product.tone];
                return (
                  <span key={product.name} className="lgl-well lgl-shop-card">
                    <Thumb kind={product.thumb} size="lg" />
                    <b className="lgl-sm lgl-clamp">{product.name}</b>
                    <span className={`lgl-xs lgl-inline lgl-${product.tone}`}>
                      <Icon />
                      {product.availability}
                    </span>
                  </span>
                );
              })}
            </div>
            <div className="lgl-row-jb">
              <span className="lgl-sm lgl-strong lgl-accent-ink lgl-inline">
                <ShoppingCart />
                Cart · 3 lines · 6 items
              </span>
              <span className="lgl-fake-btn lgl-primary">Review request</span>
            </div>
          </div>
        </Preview>
      </div>
    </section>
  );
}

export function CountsSection() {
  return (
    <section
      className="lgs-wrap lgl-band-wrap mx-auto w-full max-w-[1240px] px-5 sm:px-10"
      aria-labelledby="lgl-cnt-h"
    >
      <div className="lgl-band">
        <div className="lgl-split grid items-center gap-12 lg:grid-cols-2">
          <SectionHead
            eyebrow="Cycle counts"
            id="lgl-cnt-h"
            title="Counts that keep the ledger honest."
            lede="Count a warehouse or a hand-picked selection without shutting down. Differences are measured when each line is counted, and a manager reviews before anything posts."
          />
          <Preview className="lgs-card lgl-count">
            <div className="lgl-card-h">
              <span className="lgl-col lgl-grow">
                <span className="lgl-mono lgl-strong">CC-000042</span>
                <span className="lgl-xs lgl-muted">Main Warehouse · 140 of 140 lines counted</span>
              </span>
              <Badge tone="accent">
                <Check />
                Ready to post
              </Badge>
            </div>
            <div className="lgl-table lgl-count-table">
              <div className="lgl-tr lgl-th">
                <span>Line</span>
                <span className="lgl-r">System</span>
                <span className="lgl-r">Counted</span>
                <span className="lgl-r">Difference</span>
              </div>
              {COUNT_LINES.map((line) => (
                <div key={line.name} className="lgl-tr">
                  <span className="lgl-td-item">
                    <Thumb kind={line.thumb} size="sm" />
                    <span className="lgl-col">
                      <span className="lgl-sm lgl-clamp">{line.name}</span>
                      <span className="lgl-xs lgl-muted lgl-clamp">{line.location}</span>
                    </span>
                  </span>
                  <span className="lgl-r lgl-num">{line.system}</span>
                  <span className="lgl-r lgl-num lgl-strong">{line.counted}</span>
                  <span className={`lgl-r lgl-num lgl-strong lgl-${line.tone}`}>{line.diff}</span>
                </div>
              ))}
            </div>
            <div className="lgl-card-f">
              <span className="lgl-xs lgl-muted lgl-grow">
                A manager reviews and posts this count.
              </span>
              <span className="lgl-fake-btn lgl-primary">Review and post</span>
            </div>
          </Preview>
        </div>
      </div>
    </section>
  );
}

export function ReportsSection() {
  return (
    <section className="lgl-sec" aria-labelledby="lgl-rep-h">
      <div className="lgs-wrap lgl-split mx-auto grid w-full max-w-[1240px] gap-12 px-5 sm:px-10 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionHead
            eyebrow="Reports"
            id="lgl-rep-h"
            title="Totals you can trace to the order."
            lede="Book Order Totals counts copies requested across every matching order—not just the page on screen—and opens the orders behind each number."
          />
          <div className="lgl-facts">
            <Fact icon={<Calendar />} title="Exact dates, your time zone">
              Presets or a precise From and To, with the scope always spelled out.
            </Fact>
            <Fact icon={<Download />} title="Export what you see">
              Inventory valuation, movements, shrinkage, supplier scorecards and more, to Excel, PDF
              or CSV.
            </Fact>
          </div>
        </div>
        <Preview className="lgl-stage">
          <div className="lgs-card lgl-report">
            <div className="lgl-card-h">
              <span className="lgl-title-sm lgl-grow">Book Order Totals</span>
              <span className="lgl-chip">Last 30 days</span>
              <span className="lgl-chip">All charters</span>
            </div>
            <div className="lgl-stats">
              <span className="lgl-stat">
                <b>642</b>Total books ordered
              </span>
              <span className="lgl-stat">
                <b>32</b>Distinct book entries
              </span>
              <span className="lgl-stat">
                <b>57</b>Orders containing books
              </span>
            </div>
            <div className="lgl-list">
              {BOOK_TOTALS.map((book) => (
                <span key={book.title} className="lgl-li">
                  <Thumb kind="book" />
                  <span className="lgl-col lgl-grow">
                    <b className="lgl-sm lgl-clamp">{book.title}</b>
                    <span className="lgl-xs lgl-muted">{book.orders}</span>
                  </span>
                  <span className="lgl-num lgl-strong">{book.copies}</span>
                  <span className="lgl-fake-btn lgl-ghost">View orders</span>
                </span>
              ))}
            </div>
          </div>
        </Preview>
      </div>
    </section>
  );
}

export function MobileSection() {
  return (
    <section id="mobile" className="lgl-sec lgl-tight" aria-labelledby="lgl-mob-h">
      <div className="lgs-wrap mx-auto flex w-full max-w-[1240px] flex-col gap-10 px-5 sm:px-10">
        <SectionHead
          eyebrow="Web & mobile"
          id="lgl-mob-h"
          title="The same order, built for where you’re standing."
          lede="The web app, iPad and iPhone share one account and one record. Each screen is shaped for the work done there, not shrunk from the desk."
          width={780}
        />
        <div className="lgl-devices">
          <div className="lgl-dev lgl-desk">
            <Preview className="lgs-card lgl-desk-card">
              <span className="lgl-xs lgl-muted lgl-mono lgl-bar">
                stockpilotusa.com/dashboard/orders
              </span>
              <div className="lgl-desk-grid">
                <div className="lgl-col lgl-gap">
                  <span className="lgl-row">
                    <span className="lgl-mono lgl-strong">SO-000231</span>
                    <Badge tone="warn">Pending</Badge>
                  </span>
                  <span className="lgl-xs lgl-muted">
                    Delivery · North Campus — Main office · Fri, Nov 6, 3:00 PM PT
                  </span>
                  {ORDER_LINES.map((line) => (
                    <span key={line.name} className="lgl-row lgl-sm">
                      <Thumb kind={line.thumb} size="sm" />
                      <span className="lgl-grow lgl-clamp">{line.name}</span>
                      <span className="lgl-num lgl-strong">×{line.qty}</span>
                    </span>
                  ))}
                </div>
                <div className="lgl-col lgl-gap lgl-timeline">
                  <span className="lgl-xs lgl-strong lgl-muted">Timeline</span>
                  <span className="lgl-tl">
                    <span className="lgl-tl-dot lgl-ok">
                      <Check />
                    </span>
                    Placed by Priya · 8:14 AM
                  </span>
                  <span className="lgl-tl">
                    <span className="lgl-tl-dot lgl-info">
                      <Send />
                    </span>
                    Delivery request email sent · not an approval
                  </span>
                  <span className="lgl-tl lgl-muted">
                    <span className="lgl-tl-dot" />
                    Waiting for approval
                  </span>
                </div>
              </div>
            </Preview>
            <h3 className="lgl-dev-t font-semibold">At the desk</h3>
            <p className="lgl-dev-d text-sm">Every line, its stock and its history in one view.</p>
          </div>
          <div className="lgl-dev lgl-ipad">
            <Preview className="lgs-card lgl-ipad-card">
              <div className="lgl-ipad-grid">
                <div className="lgl-col">
                  <span className="lgl-strong">Orders</span>
                  {TABLET_ORDERS.map((order) => (
                    <span
                      key={order.number}
                      className={'current' in order ? 'lgl-ipad-row lgl-on' : 'lgl-ipad-row'}
                    >
                      <span className="lgl-xs lgl-strong lgl-mono">{order.number}</span>
                      <span className="lgl-xs lgl-muted lgl-clamp">{order.line}</span>
                    </span>
                  ))}
                </div>
                <div className="lgl-col lgl-gap">
                  <span className="lgl-row">
                    <span className="lgl-sm lgl-strong lgl-mono">SO-000231</span>
                    <Badge tone="warn">Pending</Badge>
                  </span>
                  <span className="lgl-well lgl-col lgl-gap">
                    <span className="lgl-xs lgl-muted">9 lines · delivery Fri, Nov 6</span>
                    <span className="lgl-prog">
                      <i />
                    </span>
                    <span className="lgl-xs">8 of 9 lines in stock to pick</span>
                  </span>
                  <span className="lgl-fake-btn lgl-primary">Review</span>
                </div>
              </div>
            </Preview>
            <h3 className="lgl-dev-t font-semibold">On a tablet</h3>
            <p className="lgl-dev-d text-sm">
              List and detail side by side, with keyboard and pointer.
            </p>
          </div>
          <div className="lgl-dev lgl-phone">
            <Preview className="lgl-phone-frame">
              <div className="lgl-col lgl-gap">
                <span className="lgl-mono lgl-strong">SO-000231</span>
                <Badge tone="warn">Pending</Badge>
                {ORDER_LINES.map((line) => (
                  <span key={line.name} className="lgs-card lgl-phone-line">
                    <Thumb kind={line.thumb} size="sm" />
                    <span className="lgl-xs lgl-grow lgl-clamp">{line.name}</span>
                    <span className="lgl-xs lgl-num lgl-strong">×{line.qty}</span>
                  </span>
                ))}
              </div>
              <div className="lgl-phone-bar">
                <span className="lgl-fake-btn lgl-primary lgl-grow">Approve</span>
                <span className="lgl-fake-btn lgl-icon">
                  <ScanLine />
                </span>
              </div>
            </Preview>
            <h3 className="lgl-dev-t font-semibold">In the aisle</h3>
            <p className="lgl-dev-d text-sm">One task at a time, scanning a tap away.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function RolesSection() {
  return (
    <section className="lgl-sec lgl-tight" aria-labelledby="lgl-roles-h">
      <div className="lgs-wrap lgl-roles mx-auto grid w-full max-w-[1240px] items-start gap-12 px-5 sm:px-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-4">
          <SectionHead
            eyebrow="Access"
            id="lgl-roles-h"
            title="Invite-only, with access that matches the job."
            lede="There is no public sign-up. Your workspace admin invites people from Team, chooses their role and the warehouses they work in, and can require an authenticator for admins or everyone."
          />
          <p className="lgl-alert lgl-tone-info flex items-start gap-3 text-sm">
            <Network className="size-[18px] shrink-0" aria-hidden="true" />
            <span>
              StockPilot’s own support tools are separate from your workspace and never appear in
              your navigation.
            </span>
          </p>
        </div>
        <ul className="lgs-card lgl-role-list" aria-label="Roles">
          {ASSIGNABLE_ROLES.map((role) => {
            const label = ROLE_LABELS[role];
            const look = ROLE_TONES[role] ?? { initials: '', tone: 1 };
            return (
              <li key={role} className="lgl-li">
                <span className={`lgl-av lgl-av-${look.tone}`} aria-hidden="true">
                  {look.initials}
                </span>
                <span className="lgl-col lgl-grow">
                  <span className="lgl-role-name font-semibold">{label.label}</span>
                  <span className="lgl-sm lgl-muted">{label.description}</span>
                </span>
              </li>
            );
          })}
          <li className="lgl-li">
            <span className={`lgl-av lgl-av-${REQUESTER_LINK.tone}`} aria-hidden="true">
              {REQUESTER_LINK.initials}
            </span>
            <span className="lgl-col lgl-grow">
              <span className="lgl-role-name font-semibold">{REQUESTER_LINK.name}</span>
              <span className="lgl-sm lgl-muted">{REQUESTER_LINK.description}</span>
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}

export function FaqSection() {
  return (
    <section className="lgl-sec lgl-tight" aria-labelledby="lgl-faq-h">
      <div className="lgs-wrap mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-5 sm:px-10">
        <h2 className="lgs-h2 text-4xl font-semibold" id="lgl-faq-h">
          Questions
        </h2>
        <div className="lgl-faq">
          {FAQ.map((item) => (
            <details key={item.q}>
              <summary>
                {item.q}
                <Plus className="lgl-faq-ic" aria-hidden="true" />
              </summary>
              <p className="lgl-ans">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function CloseSection() {
  return (
    <section
      className="lgs-wrap lgl-close-wrap mx-auto w-full max-w-[1240px] px-5 pb-24 sm:px-10"
      aria-labelledby="lgl-close-h"
    >
      <div className="lgl-close lgs-glass flex flex-col items-center gap-5 text-center">
        <SiteGlyph maskId="lgl-close-mark" className="lgl-close-mark size-12" />
        <h2 className="lgs-h2 text-4xl font-semibold" id="lgl-close-h">
          Ready when your invitation is.
        </h2>
        <p className="lgs-lede max-w-[560px] text-lg">
          Sign in with the account from your invitation, or talk to the team about bringing
          StockPilot to your operation.
        </p>
        <div className="lgl-cta flex flex-wrap justify-center gap-2.5">
          <AppEntryLink where="close-sign-in" className={buttonClass('primary', 'xl')}>
            Sign in
          </AppEntryLink>
          <Link href="/contact" className={buttonClass('secondary', 'xl')}>
            Contact the team
          </Link>
        </div>
      </div>
    </section>
  );
}
