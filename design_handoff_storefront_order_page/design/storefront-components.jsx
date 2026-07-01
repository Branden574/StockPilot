/* global React */
// StockPilot Storefront — presentational components.
const { useState: useSFState, useEffect: useSFEffect, useRef: useSFRef } = React;
const SFD = window.SF_DATA;

// ---- glyph for photo-less items -----------------------------------------
function sfGlyph(it) {
  return it.name.replace(/^L4L\s+/, "").split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

// ---- generic popover ------------------------------------------------------
function SFPop({ open, onClose, right, children, width }) {
  const ref = useSFRef(null);
  useSFEffect(() => {
    if (!open) return;
    const h = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const k = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  if (!open) return null;
  return <div className={"sf-pop" + (right ? " right" : "")} style={width ? { minWidth: width } : null} ref={ref}>{children}</div>;
}

// ---- photo box -------------------------------------------------------------
function SFPhoto({ it }) {
  return (
    <div className="sf-ph">
      {it.img
        ? <img src={it.img} alt={it.name} loading="lazy" />
        : <span className="glyph">{sfGlyph(it)}</span>}
    </div>
  );
}

// ---- availability pill ------------------------------------------------------
function SFAvail({ it }) {
  const s = SFD.statusOf(it);
  const label = s === "out" ? "Out of stock" : s === "low" ? `Low · ${it.stock} left` : `${it.stock} avail`;
  return (
    <span className={"sf-avail " + (s === "ok" ? "" : s)}>
      <span className="d"></span>{label}
    </span>
  );
}

// ---- add / stepper control ---------------------------------------------------
function SFAddControl({ it, qty, add, sub }) {
  const out = it.stock === 0;
  if (out) {
    return <button className="sf-add oos" disabled={true}>Out of stock</button>;
  }
  if (qty === 0) {
    return (
      <button className="sf-add" onClick={() => add(it.sku)}>
        <SFIcon name="plus" size={13} /> Add to cart
      </button>
    );
  }
  const atMax = qty >= it.stock;
  return (
    <div className="sf-step">
      <button onClick={() => sub(it.sku)} aria-label="Decrease"><SFIcon name="minus" size={13} /></button>
      <span className="q">{qty}<span className="in-lbl">IN CART</span></span>
      <button onClick={() => add(it.sku)} disabled={atMax} title={atMax ? "All available stock is in your cart" : "Increase"} aria-label="Increase">
        <SFIcon name="plus" size={13} />
      </button>
    </div>
  );
}

// ---- product card (grid) -------------------------------------------------------
function SFProductCard({ it, qty, add, sub, onQuick }) {
  const out = it.stock === 0;
  return (
    <div className="sf-card" data-in-cart={qty > 0} data-out={out}>
      <div style={{ position: "relative" }}>
        <div style={{ position: "relative", aspectRatio: "4 / 3" }}>
          <div className="sf-ph" style={{ position: "absolute", inset: 0 }}>
            {it.img ? <img src={it.img} alt={it.name} loading="lazy" /> : <span className="glyph">{sfGlyph(it)}</span>}
          </div>
          <SFAvail it={it} />
          <button className="sf-qv" title="Quick view" onClick={() => onQuick(it)}><SFIcon name="eye" size={14} /></button>
        </div>
      </div>
      <div className="sf-card-bd">
        <div className="sf-card-nm">{it.name}</div>
        <div className="sf-card-meta">
          <span>{it.sku}</span>
          <span className="sep">·</span>
          <span className="cat">{it.author || it.cat}</span>
        </div>
        <div className="sf-card-ctl">
          <SFAddControl it={it} qty={qty} add={add} sub={sub} />
        </div>
      </div>
    </div>
  );
}

// ---- compact row ------------------------------------------------------------------
function SFCompactRow({ it, qty, add, sub, onQuick }) {
  const s = SFD.statusOf(it);
  return (
    <div className="sf-row" data-out={it.stock === 0}>
      <button className="th" onClick={() => onQuick(it)} title="Quick view"><SFPhoto it={it} /></button>
      <div style={{ minWidth: 0 }}>
        <div className="nm">{it.name}</div>
        <div className="sk2">{it.sku}</div>
      </div>
      <div className="cat">{it.cat}</div>
      <div className={"avl " + (s === "ok" ? "" : s)}>
        <span className="d"></span>
        {s === "out" ? "Out of stock" : s === "low" ? `Low · ${it.stock}` : `${it.stock} avail`}
      </div>
      <div><SFAddControl it={it} qty={qty} add={add} sub={sub} /></div>
    </div>
  );
}

// ---- featured carousel ---------------------------------------------------------------
function SFFeatured({ items, cart, add, sub, onQuick }) {
  const trackRef = useSFRef(null);
  const nudge = (dir) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: "smooth" });
  };
  return (
    <section className="sf-feat" data-screen-label="Frequently ordered">
      <div className="sf-sec-head">
        <h3><SFIcon name="sparkles" size={15} /> Frequently ordered</h3>
        <span className="sub">Based on your last 30 days</span>
        <span className="spacer"></span>
        <div className="sf-arrows">
          <button onClick={() => nudge(-1)} aria-label="Scroll back"><SFIcon name="chevL" size={14} /></button>
          <button onClick={() => nudge(1)} aria-label="Scroll forward"><SFIcon name="chevR" size={14} /></button>
        </div>
      </div>
      <div className="sf-feat-track" ref={trackRef}>
        {items.map((it, i) => {
          const qty = cart[it.sku] || 0;
          const s = SFD.statusOf(it);
          return (
            <div className="sf-feat-card" key={it.sku} data-in-cart={qty > 0}>
              <div style={{ position: "relative" }}>
                <div className="ph" style={{ position: "relative", height: 112 }}>
                  <div className="sf-ph" style={{ position: "absolute", inset: 0 }}>
                    {it.img ? <img src={it.img} alt={it.name} loading="lazy" /> : <span className="glyph">{sfGlyph(it)}</span>}
                  </div>
                </div>
                <span className="sf-feat-rank">#{i + 1} · {it.freq}×/mo</span>
                <button className="sf-qv" title="Quick view" onClick={() => onQuick(it)}><SFIcon name="eye" size={13} /></button>
              </div>
              <div className="bd">
                <div className="nm">{it.name}</div>
                <div className="ft">
                  <span className={"av " + (s === "low" ? "low" : "")}>
                    <span className="d"></span>{it.stock} avail
                  </span>
                  {qty === 0 ? (
                    <button className="sf-add-mini" onClick={() => add(it.sku)} disabled={it.stock === 0} aria-label={"Add " + it.name}>
                      <SFIcon name="plus" size={13} />
                    </button>
                  ) : (
                    <div className="sf-step mini" style={{ width: "auto" }}>
                      <button onClick={() => sub(it.sku)}><SFIcon name="minus" size={11} /></button>
                      <span className="q">{qty}</span>
                      <button onClick={() => add(it.sku)} disabled={qty >= it.stock}><SFIcon name="plus" size={11} /></button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---- cart rail --------------------------------------------------------------------------
function SFCartRail({ lines, cart, add, sub, remove, clear, notes, setNotes, setup, onSubmit, suggestions }) {
  const [notesOpen, setNotesOpen] = useSFState(false);
  const [pulse, setPulse] = useSFState(false);
  const units = lines.reduce((a, l) => a + l.qty, 0);
  const firstUnits = useSFRef(true);
  useSFEffect(() => {
    if (firstUnits.current) { firstUnits.current = false; return; }
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 320);
    return () => clearTimeout(t);
  }, [units]);

  return (
    <div className="sf-cart" data-screen-label="Order cart">
      <div className="sf-cart-head">
        <SFIcon name="cart" size={15} />
        <span className="ttl">Order Cart</span>
        <span className={"cnt" + (pulse ? " pulse" : "")} data-zero={units === 0}>{units}</span>
        {lines.length > 0 && <button className="clr" onClick={clear}>Clear all</button>}
      </div>

      <div className="sf-cart-ctx">
        <span className="sf-ctx-chip"><SFIcon name="boxes" size={11} />{setup.warehouse.id}</span>
        <span className="sf-ctx-chip">
          <SFIcon name={setup.method === "pickup" ? "pkg" : "truck"} size={11} />
          {setup.method === "pickup" ? "Pickup · will-call" : setup.site.name}
        </span>
        <span className="sf-ctx-chip"><SFIcon name="users" size={11} />{setup.person.id === "you" ? "For you" : "For " + setup.person.name.split(" ")[0]}</span>
      </div>

      <div className="sf-cart-list">
        {lines.length === 0 ? (
          <div className="sf-cart-empty">
            <div className="ring"><SFIcon name="cart" size={26} /></div>
            <h5>Your cart is empty</h5>
            <p>Browse the catalog and add items —<br />they queue here until you submit.</p>
            {suggestions.length > 0 && (
              <div className="sf-sugg">
                <div className="sf-sugg-lbl">Start with your usuals</div>
                {suggestions.map(s => (
                  <button key={s.sku} onClick={() => add(s.sku)}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                    <span className="plus"><SFIcon name="plus" size={12} /></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          lines.map(l => {
            const atMax = l.qty >= l.item.stock;
            const over = l.qty > l.item.stock;
            return (
              <div className="sf-line" key={l.item.sku}>
                <div className="th"><SFPhoto it={l.item} /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="nm">{l.item.name}</div>
                  <div className="sk2">{l.item.sku}</div>
                </div>
                <div className="rt">
                  <button className="rm" title="Remove" onClick={() => remove(l.item.sku)}><SFIcon name="trash" size={12} /></button>
                  <div className="sf-step mini" style={{ width: "auto" }}>
                    <button onClick={() => sub(l.item.sku)}><SFIcon name="minus" size={11} /></button>
                    <span className="q">{l.qty}</span>
                    <button onClick={() => add(l.item.sku)} disabled={atMax}><SFIcon name="plus" size={11} /></button>
                  </div>
                </div>
                {(atMax || over) && (
                  <div className="sf-line-warn">
                    <SFIcon name="warn" size={12} />
                    {over ? `Only ${l.item.stock} in stock — reduce quantity` : `All ${l.item.stock} available are in your cart`}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="sf-notes" data-open={notesOpen}>
        <button className="sf-notes-head" onClick={() => setNotesOpen(o => !o)}>
          <SFIcon name="note" size={13} />
          <span>Manager notes</span>
          <span className="opt">Optional</span>
          {!notesOpen && notes.trim() !== "" && <span className="dot-has"></span>}
          <span className="chev"><SFIcon name="chevD" size={13} /></span>
        </button>
        {notesOpen && (
          <textarea
            placeholder="Anything the approving manager should know — deadlines, event, room number…"
            value={notes}
            onChange={e => setNotes(e.target.value)}
          ></textarea>
        )}
      </div>

      <div className="sf-cart-foot">
        <div className="sf-tot"><span>Line items</span><span className="v">{lines.length}</span></div>
        <div className="sf-tot"><span>Total units</span><span className="v">{units}</span></div>
        <button className="sf-submit" disabled={lines.length === 0} onClick={onSubmit}>
          Submit Order Request <SFIcon name="chevR" size={14} />
        </button>
        <div className="fine">A manager will review and approve before stock is reserved.</div>
      </div>
    </div>
  );
}

// ---- quick view drawer ---------------------------------------------------------------------
function SFQuickView({ it, qty, add, sub, onClose }) {
  if (!it) return null;
  const s = SFD.statusOf(it);
  return (
    <React.Fragment>
      <div className="drawer-backdrop" onClick={onClose}></div>
      <div className="drawer sf-qv-drawer" data-screen-label="Quick view">
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="page-eyebrow" style={{ marginBottom: 2 }}>{it.cat}</div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}>{it.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><SFIcon name="x" size={15} /></button>
        </div>
        <div className="drawer-body">
          <div className="sf-qv-photo"><SFPhoto it={it} /></div>
          <div className="sf-spec">
            <div><div className="k">SKU</div><div className="v">{it.sku}</div></div>
            <div><div className="k">Bin location</div><div className="v">DC4 · {it.loc}</div></div>
            <div><div className="k">Available</div><div className="v">{it.stock} units</div></div>
            <div><div className="k">Status</div><div className="v">{s === "out" ? "Out of stock" : s === "low" ? "Low stock" : "In stock"}</div></div>
          </div>
          {it.desc && <p style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.6, margin: 0 }}>{it.desc}</p>}
        </div>
        <div className="drawer-foot" style={{ justifyContent: "stretch" }}>
          <div style={{ width: "100%" }}>
            <SFAddControl it={it} qty={qty} add={add} sub={sub} />
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

// ---- review + success modal -------------------------------------------------------------------
function SFReviewModal({ stage, lines, notes, setup, onClose, onConfirm, onDone }) {
  if (!stage) return null;
  const units = lines.reduce((a, l) => a + l.qty, 0);
  return (
    <div className="sf-modal-bk" onMouseDown={stage === "review" ? onClose : undefined}>
      <div className="sf-modal" onMouseDown={e => e.stopPropagation()} data-screen-label="Review order">
        {stage === "review" ? (
          <React.Fragment>
            <div className="sf-modal-head">
              <SFIcon name="clipboard" size={16} />
              <div>
                <h3>Review order request</h3>
                <div className="sub">Check the details — your manager sees exactly this.</div>
              </div>
              <button className="icon-btn x" onClick={onClose}><SFIcon name="x" size={15} /></button>
            </div>
            <div className="sf-modal-body">
              <div className="sf-rev-grid">
                <div><div className="k">Warehouse</div><div className="v">{setup.warehouse.name}</div></div>
                <div><div className="k">Method</div><div className="v">{setup.method === "pickup" ? "Pickup · will-call" : "Delivery"}</div></div>
                <div><div className="k">Deliver to</div><div className="v">{setup.method === "pickup" ? "DC4 will-call desk" : setup.site.name}</div></div>
                <div><div className="k">Requested for</div><div className="v">{setup.person.name}</div></div>
              </div>
              <div>
                {lines.map(l => (
                  <div className="sf-rev-line" key={l.item.sku}>
                    <div className="th"><SFPhoto it={l.item} /></div>
                    <div style={{ minWidth: 0 }}>
                      <div className="nm">{l.item.name}</div>
                      <div className="sk2">{l.item.sku}</div>
                    </div>
                    <div className="q">× {l.qty}</div>
                  </div>
                ))}
              </div>
              {notes.trim() !== "" && (
                <div style={{ marginTop: 14, padding: "11px 14px", border: "1px dashed var(--line-strong)", borderRadius: 10, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.55 }}>
                  <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-4)", fontWeight: 500, marginBottom: 4 }}>Manager notes</div>
                  {notes}
                </div>
              )}
            </div>
            <div className="sf-modal-foot">
              <span className="grow2">{lines.length} line items · {units} units</span>
              <button className="sf-btn-ghost" onClick={onClose}>Keep browsing</button>
              <button className="sf-btn-go" onClick={onConfirm}><SFIcon name="check" size={14} /> Confirm &amp; submit</button>
            </div>
          </React.Fragment>
        ) : (
          <div className="sf-success">
            <div className="ok"><SFIcon name="check" size={30} stroke={2} /></div>
            <h3>Order request submitted</h3>
            <div className="ref">SO-2661 · {setup.warehouse.id} · {units} units</div>
            <p>Your manager has been notified. You'll get an email when it's approved and stock is reserved for {setup.method === "pickup" ? "pickup" : "delivery"}.</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="sf-btn-ghost">View order</button>
              <button className="sf-btn-go" onClick={onDone}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- skeleton loading state ----------------------------------------------------------------------
function SFSkeletonGrid({ cols }) {
  return (
    <div>
      <div className="sf-sk" style={{ width: 220, height: 20, marginBottom: 14 }}></div>
      <div className="sf-grid" style={{ "--cols": cols }}>
        {Array.from({ length: cols * 2 }).map((_, i) => (
          <div className="sf-sk-card" key={i}>
            <div className="sf-sk ph"></div>
            <div className="bd">
              <div className="sf-sk" style={{ height: 13, width: "85%" }}></div>
              <div className="sf-sk" style={{ height: 13, width: "55%" }}></div>
              <div className="sf-sk" style={{ height: 30, width: "100%", marginTop: 6, borderRadius: 9 }}></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- flow indicator ---------------------------------------------------------------------------------
function SFFlow({ stage }) {
  const steps = ["Browse", "Cart", "Review", "Submit"];
  const idx = { browse: 0, cart: 1, review: 2, submit: 3 }[stage] ?? 0;
  return (
    <div className="sf-flow" aria-label="Order progress">
      {steps.map((s, i) => (
        <React.Fragment key={s}>
          {i > 0 && <span className="sf-flow-sep"></span>}
          <span className="sf-flow-step" data-state={i < idx ? "done" : i === idx ? "active" : "todo"}>
            <span className="fdot">{i < idx ? <SFIcon name="check" size={10} stroke={2.2} /> : null}</span>
            <span className="flabel">{s}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---- empty results -----------------------------------------------------------------------------------
function SFEmptyResults({ query, onClear }) {
  return (
    <div className="sf-empty">
      <div className="big"><SFIcon name="search" size={24} /></div>
      <h4>Nothing matches{query ? ` "${query}"` : " those filters"}</h4>
      <p>Try a different name, SKU or category — or clear your filters.</p>
      <button className="sf-btn-ghost" onClick={onClear}>Clear search &amp; filters</button>
    </div>
  );
}

Object.assign(window, {
  SFPop, SFPhoto, SFAvail, SFAddControl, SFProductCard, SFCompactRow,
  SFFeatured, SFCartRail, SFQuickView, SFReviewModal, SFSkeletonGrid, SFFlow, SFEmptyResults,
});
