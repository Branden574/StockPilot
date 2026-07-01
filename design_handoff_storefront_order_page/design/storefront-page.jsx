/* global React, ReactDOM */
// StockPilot Storefront — Place an Order (v3): page assembly.
const { useState, useEffect, useMemo, useRef } = React;
const DATA = window.SF_DATA;
const { useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakToggle } = window;

const SF_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "cols": 4,
  "view": "Grid",
  "accent": "Green",
  "dark": true,
  "featured": true,
  "grouped": true,
  "loading": false
}/*EDITMODE-END*/;

const SF_ACCENTS = {
  Green: { dark: ["oklch(0.82 0.13 165)", "oklch(0.22 0.05 165)"], light: ["oklch(0.74 0.12 165)", "oklch(0.96 0.04 165)"] },
  Teal:  { dark: ["oklch(0.82 0.10 200)", "oklch(0.22 0.04 200)"], light: ["oklch(0.72 0.10 200)", "oklch(0.96 0.03 200)"] },
  Ivory: { dark: ["oklch(0.90 0.015 95)", "oklch(0.24 0.01 95)"],  light: ["oklch(0.45 0.02 95)",  "oklch(0.95 0.01 95)"] },
};

const SF_LS_KEY = "sf-storefront-v3";

function loadPersisted() {
  try { return JSON.parse(localStorage.getItem(SF_LS_KEY)) || {}; } catch { return {}; }
}

// ==========================================================================
function StorefrontPage() {
  const [t, setTweak] = useTweaks(SF_TWEAK_DEFAULTS);
  const persisted = useRef(loadPersisted()).current;

  // ---- order setup ----
  const [warehouse, setWarehouse] = useState(() => DATA.WAREHOUSES.find(w => w.id === (persisted.wh || "DC4")) || DATA.WAREHOUSES[0]);
  const [person, setPerson] = useState(() => DATA.PEOPLE.find(p => p.id === (persisted.person || "you")) || DATA.PEOPLE[0]);
  const [method, setMethod] = useState(persisted.method || "pickup");
  const [site, setSite] = useState(() => DATA.SITES.find(s => s.id === (persisted.site || "fresno-main")) || DATA.SITES[0]);
  const [openPop, setOpenPop] = useState(null); // 'wh' | 'person' | 'site'
  const [personQ, setPersonQ] = useState("");

  // ---- catalog controls ----
  const [cat, setCat] = useState("All");
  const [search, setSearch] = useState("");
  const [avail, setAvail] = useState(() => new Set());
  const [sort, setSort] = useState("relevance");
  const [toolPop, setToolPop] = useState(null); // 'avail' | 'sort'
  const [collapsed, setCollapsed] = useState(() => new Set());

  // ---- cart ----
  const [cart, setCart] = useState(persisted.cart || {});
  const [notes, setNotes] = useState(persisted.notes || "");
  const [quick, setQuick] = useState(null);
  const [reviewStage, setReviewStage] = useState(null); // null | 'review' | 'done'

  // persistence
  useEffect(() => {
    const payload = { cart, notes, method, wh: warehouse.id, site: site.id, person: person.id };
    localStorage.setItem(SF_LS_KEY, JSON.stringify(payload));
  }, [cart, notes, method, warehouse, site, person]);

  // theme + accent
  useEffect(() => { document.body.setAttribute("data-theme", t.dark ? "dark" : "light"); }, [t.dark]);
  useEffect(() => {
    const a = SF_ACCENTS[t.accent] || SF_ACCENTS.Green;
    const [accent, wash] = t.dark ? a.dark : a.light;
    const root = document.documentElement;
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-wash", wash);
    if (!t.dark) root.style.setProperty("--accent-ink", t.accent === "Ivory" ? "oklch(0.35 0.02 95)" : "oklch(0.32 0.06 165)");
    else root.style.removeProperty("--accent-ink");
  }, [t.accent, t.dark]);

  // ---- cart ops ----
  const add = (sku) => setCart(c => {
    const it = DATA.ITEMS.find(i => i.sku === sku);
    const cur = c[sku] || 0;
    if (!it || it.stock === 0 || cur >= it.stock) return c;
    return { ...c, [sku]: cur + 1 };
  });
  const sub = (sku) => setCart(c => {
    const n = (c[sku] || 0) - 1;
    const o = { ...c };
    if (n <= 0) delete o[sku]; else o[sku] = n;
    return o;
  });
  const removeLine = (sku) => setCart(c => { const o = { ...c }; delete o[sku]; return o; });
  const clearCart = () => setCart({});

  const lines = useMemo(() =>
    Object.entries(cart)
      .map(([sku, qty]) => ({ item: DATA.ITEMS.find(i => i.sku === sku), qty }))
      .filter(l => l.item),
    [cart]);
  const units = lines.reduce((a, l) => a + l.qty, 0);

  // ---- filtering ----
  const counts = useMemo(() => {
    const out = { All: DATA.ITEMS.length };
    for (const c of DATA.CATS) out[c.id] = DATA.ITEMS.filter(i => i.cat === c.id).length;
    return out;
  }, []);

  const filtered = useMemo(() => {
    let out = DATA.ITEMS.slice();
    if (cat !== "All") out = out.filter(i => i.cat === cat);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(i =>
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        i.cat.toLowerCase().includes(q) ||
        (i.author || "").toLowerCase().includes(q));
    }
    if (avail.size > 0) out = out.filter(i => avail.has(DATA.statusOf(i)));
    switch (sort) {
      case "name-asc": out.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "name-desc": out.sort((a, b) => b.name.localeCompare(a.name)); break;
      case "stock-desc": out.sort((a, b) => b.stock - a.stock); break;
      case "stock-asc": out.sort((a, b) => a.stock - b.stock); break;
      case "freq": out.sort((a, b) => (b.freq || 0) - (a.freq || 0)); break;
      default: break; // relevance = catalog order
    }
    return out;
  }, [cat, search, avail, sort]);

  const featured = useMemo(() =>
    DATA.ITEMS.filter(i => i.freq).sort((a, b) => b.freq - a.freq).slice(0, 10), []);
  const suggestions = useMemo(() => featured.filter(i => i.stock > 0).slice(0, 3), [featured]);

  const isBrowsingAll = cat === "All" && !search.trim() && avail.size === 0;
  const grouped = useMemo(() => {
    if (!t.grouped || !isBrowsingAll) return null;
    return DATA.CATS.map(c => ({ ...c, items: filtered.filter(i => i.cat === c.id) })).filter(g => g.items.length > 0);
  }, [filtered, isBrowsingAll, t.grouped]);

  // flow stage
  const stage = reviewStage === "done" ? "submit" : reviewStage === "review" ? "review" : lines.length > 0 ? "cart" : "browse";

  // sort labels
  const SORTS = [
    ["relevance", "Featured"],
    ["freq", "Most ordered by you"],
    ["name-asc", "Name · A–Z"],
    ["name-desc", "Name · Z–A"],
    ["stock-desc", "Most available"],
    ["stock-asc", "Least available"],
  ];
  const sortLabel = Object.fromEntries(SORTS)[sort];

  const clearAllFilters = () => { setSearch(""); setAvail(new Set()); setCat("All"); };
  const railRef = useRef(null);

  const setupData = { warehouse, person, method, site };
  const addKit = (items) => items.forEach(i => { if (i.stock > 0) add(i.sku); });

  const renderItems = (items) => (
    t.view === "Grid" ? (
      <div className="sf-grid" style={{ "--cols": t.cols }}>
        {items.map(it => (
          <SFProductCard key={it.sku} it={it} qty={cart[it.sku] || 0} add={add} sub={sub} onQuick={setQuick} />
        ))}
      </div>
    ) : (
      <div className="sf-rows">
        {items.map(it => (
          <SFCompactRow key={it.sku} it={it} qty={cart[it.sku] || 0} add={add} sub={sub} onQuick={setQuick} />
        ))}
      </div>
    )
  );

  return (
    <div className="app">
      <SFSidebar />
      <div className="main">
        <SFTopbar dark={t.dark} onToggleTheme={() => setTweak("dark", !t.dark)} />

        <div className="page sf-page" data-screen-label="Place an Order">
          {/* ---------- Page head ---------- */}
          <div className="sf-head">
            <div>
              <span className="sf-back"><SFIcon name="chevL" size={12} /> Back to orders</span>
              <h1 className="sf-title">Place an Order</h1>
              <div className="sf-sub">Browse available inventory, add items to your cart, and submit for approval.</div>
            </div>
            <SFFlow stage={stage} />
          </div>

          {/* ---------- Order setup bar ---------- */}
          <div className="sf-setup" data-screen-label="Order setup">
            <div className="sf-setup-cell" onClick={() => setOpenPop(openPop === "wh" ? null : "wh")}>
              <span className="sf-setup-ic"><SFIcon name="boxes" size={15} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="lb">Warehouse</div>
                <div className="vl">{warehouse.name} <SFIcon name="chevD" size={11} /></div>
              </div>
              <SFPop open={openPop === "wh"} onClose={() => setOpenPop(null)}>
                <div className="sf-pop-label">Ship from</div>
                {DATA.WAREHOUSES.map(w => (
                  <div key={w.id} className="sf-opt" data-on={w.id === warehouse.id}
                       onClick={(e) => { e.stopPropagation(); setWarehouse(w); setOpenPop(null); }}>
                    <div><div className="nm">{w.name}</div><div className="sb">{w.sub}</div></div>
                    <span className="tick"><SFIcon name="check" size={14} /></span>
                  </div>
                ))}
              </SFPop>
            </div>

            <div className="sf-setup-cell" onClick={() => setOpenPop(openPop === "person" ? null : "person")}>
              <span className="sf-setup-ic"><SFIcon name="users" size={15} /></span>
              <div style={{ minWidth: 0 }}>
                <div className="lb">Requesting for</div>
                <div className="vl">
                  {person.id === "you" ? "Myself" : person.name}
                  <SFIcon name="chevD" size={11} />
                </div>
                <div className="hint">{person.id === "you" ? person.name : "On behalf · " + person.sub.split(" · ")[0]}</div>
              </div>
              <SFPop open={openPop === "person"} onClose={() => setOpenPop(null)}>
                <div className="srch">
                  <SFIcon name="search" size={13} />
                  <input placeholder="Search people…" value={personQ} onChange={e => setPersonQ(e.target.value)}
                         onClick={e => e.stopPropagation()} autoFocus={true} />
                </div>
                {DATA.PEOPLE.filter(p => p.name.toLowerCase().includes(personQ.toLowerCase())).map(p => (
                  <div key={p.id} className="sf-opt" data-on={p.id === person.id}
                       onClick={(e) => { e.stopPropagation(); setPerson(p); setOpenPop(null); setPersonQ(""); }}>
                    <div><div className="nm">{p.name}</div><div className="sb">{p.sub}</div></div>
                    <span className="tick"><SFIcon name="check" size={14} /></span>
                  </div>
                ))}
              </SFPop>
            </div>

            <div className="sf-seg-wrap">
              <div>
                <div className="lb" style={{ fontSize: 10.5, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--ink-4)", fontWeight: 500, marginBottom: 5 }}>Fulfillment</div>
                <div className="sf-seg">
                  <button data-active={method === "pickup"} onClick={() => setMethod("pickup")}>
                    <SFIcon name="pkg" size={13} /> Pickup
                  </button>
                  <button data-active={method === "delivery"} onClick={() => setMethod("delivery")}>
                    <SFIcon name="truck" size={13} /> Delivery
                  </button>
                </div>
              </div>
            </div>

            {method === "pickup" ? (
              <div className="sf-setup-cell static">
                <span className="sf-setup-ic"><SFIcon name="map" size={15} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="lb">Pick up at</div>
                  <div className="vl">{warehouse.id} will-call desk</div>
                  <div className="hint">Ready within 1 business day of approval</div>
                </div>
              </div>
            ) : (
              <div className="sf-setup-cell" onClick={() => setOpenPop(openPop === "site" ? null : "site")}>
                <span className="sf-setup-ic"><SFIcon name="map" size={15} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="lb">Deliver to</div>
                  <div className="vl">{site.name} <SFIcon name="chevD" size={11} /></div>
                  <div className="hint">{site.sub}</div>
                </div>
                <SFPop open={openPop === "site"} onClose={() => setOpenPop(null)} right={true}>
                  <div className="sf-pop-label">Delivery site</div>
                  {DATA.SITES.map(s => (
                    <div key={s.id} className="sf-opt" data-on={s.id === site.id}
                         onClick={(e) => { e.stopPropagation(); setSite(s); setOpenPop(null); }}>
                      <div><div className="nm">{s.name}</div><div className="sb">{s.sub}</div></div>
                      <span className="tick"><SFIcon name="check" size={14} /></span>
                    </div>
                  ))}
                </SFPop>
              </div>
            )}
          </div>

          {/* ---------- Shell: catalog + cart ---------- */}
          <div className="sf-shell">
            <div style={{ minWidth: 0 }} data-screen-label="Catalog">
              {/* Toolbar */}
              <div className="sf-sticky">
                <div className="sf-tools">
                  <div className="sf-search">
                    <SFIcon name="search" size={15} />
                    <input
                      placeholder="Search products, SKU, category…"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />
                    {search && <button className="clear" onClick={() => setSearch("")}><SFIcon name="x" size={11} /></button>}
                  </div>

                  <div style={{ position: "relative" }}>
                    <button className="sf-tool-btn" data-on={avail.size > 0} onClick={() => setToolPop(toolPop === "avail" ? null : "avail")}>
                      <SFIcon name="filter" size={13} /> Availability
                      {avail.size > 0 && <span className="bdg">{avail.size}</span>}
                      <SFIcon name="chevD" size={11} />
                    </button>
                    <SFPop open={toolPop === "avail"} onClose={() => setToolPop(null)} width={216}>
                      {[["ok", "In stock"], ["low", "Low stock"], ["out", "Out of stock"]].map(([id, label]) => (
                        <div key={id} className="sf-opt" data-on={avail.has(id)} onClick={() => {
                          const next = new Set(avail);
                          next.has(id) ? next.delete(id) : next.add(id);
                          setAvail(next);
                        }}>
                          <span className="cb" data-checked={avail.has(id)}></span>
                          <div className="nm" style={{ fontWeight: 400 }}>{label}</div>
                          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-4)" }}>
                            {DATA.ITEMS.filter(i => DATA.statusOf(i) === id).length}
                          </span>
                        </div>
                      ))}
                    </SFPop>
                  </div>

                  <div style={{ position: "relative" }}>
                    <button className="sf-tool-btn" onClick={() => setToolPop(toolPop === "sort" ? null : "sort")}>
                      <SFIcon name="sort" size={13} /> {sortLabel}
                      <SFIcon name="chevD" size={11} />
                    </button>
                    <SFPop open={toolPop === "sort"} onClose={() => setToolPop(null)} right={true} width={210}>
                      {SORTS.map(([id, label]) => (
                        <div key={id} className="sf-opt" data-on={id === sort} onClick={() => { setSort(id); setToolPop(null); }}>
                          <div className="nm" style={{ fontWeight: 400 }}>{label}</div>
                          <span className="tick"><SFIcon name="check" size={14} /></span>
                        </div>
                      ))}
                    </SFPop>
                  </div>

                  <div className="sf-viewseg">
                    <button data-active={t.view === "Grid"} title="Grid view" onClick={() => setTweak("view", "Grid")}><SFIcon name="grid" size={14} /></button>
                    <button data-active={t.view === "Compact"} title="Compact view" onClick={() => setTweak("view", "Compact")}><SFIcon name="list" size={14} /></button>
                  </div>
                </div>

                {/* Category pills */}
                <div className="sf-pills">
                  <button className="sf-pill" data-active={cat === "All"} onClick={() => setCat("All")}>
                    All <span className="ct">{counts.All}</span>
                  </button>
                  {DATA.CATS.map(c => (
                    <button key={c.id} className="sf-pill" data-active={cat === c.id} onClick={() => setCat(cat === c.id ? "All" : c.id)}>
                      <SFIcon name={c.icon} size={13} />
                      {c.id} <span className="ct">{counts[c.id]}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Active filter chips */}
              {(search.trim() || avail.size > 0) && (
                <div className="sf-chips">
                  {search.trim() && (
                    <span className="sf-chip">“{search.trim()}”<button onClick={() => setSearch("")}><SFIcon name="x" size={10} /></button></span>
                  )}
                  {[...avail].map(a => (
                    <span className="sf-chip" key={a}>
                      {{ ok: "In stock", low: "Low stock", out: "Out of stock" }[a]}
                      <button onClick={() => { const n = new Set(avail); n.delete(a); setAvail(n); }}><SFIcon name="x" size={10} /></button>
                    </span>
                  ))}
                  <span className="clear-all" onClick={clearAllFilters}>Clear all</span>
                </div>
              )}

              {/* Content */}
              {t.loading ? (
                <SFSkeletonGrid cols={t.cols} />
              ) : (
                <React.Fragment>
                  {t.featured && isBrowsingAll && (
                    <SFFeatured items={featured} cart={cart} add={add} sub={sub} onQuick={setQuick} />
                  )}

                  {grouped ? (
                    grouped.map(g => {
                      const open = !collapsed.has(g.id);
                      return (
                        <section className="sf-cat-sec" key={g.id} data-open={open} data-screen-label={g.id}>
                          <div className="sf-sec-head">
                            <button className="fold" onClick={() => {
                              const n = new Set(collapsed);
                              open ? n.add(g.id) : n.delete(g.id);
                              setCollapsed(n);
                            }} aria-label={open ? "Collapse" : "Expand"}>
                              <SFIcon name="chevD" size={14} />
                            </button>
                            <h3><SFIcon name={g.icon} size={15} /> {g.id}</h3>
                            <span className="ct">{g.items.length}</span>
                            <span className="spacer"></span>
                            {g.id === "New Hire" && (
                              <button className="sf-kit-btn" onClick={() => addKit(g.items)} title="Add one of each in-stock kit item">
                                <SFIcon name="plus" size={12} /> Add full kit
                              </button>
                            )}
                            {g.items.length > t.cols && (
                              <span className="see" onClick={() => setCat(g.id)}>View all {g.items.length} <SFIcon name="chevR" size={12} /></span>
                            )}
                          </div>
                          {open && renderItems(g.items.slice(0, t.view === "Grid" ? t.cols : 6))}
                        </section>
                      );
                    })
                  ) : (
                    <React.Fragment>
                      <div className="sf-result-line">
                        <span className="n">{cat === "All" ? "All products" : cat}</span>
                        <span className="m">{filtered.length} {filtered.length === 1 ? "item" : "items"}{search.trim() ? " matching" : ""}</span>
                      </div>
                      {filtered.length === 0
                        ? <SFEmptyResults query={search.trim()} onClear={clearAllFilters} />
                        : renderItems(filtered)}
                    </React.Fragment>
                  )}
                </React.Fragment>
              )}
            </div>

            {/* Cart rail */}
            <div className="sf-rail" ref={railRef}>
              <SFCartRail
                lines={lines} cart={cart} add={add} sub={sub}
                remove={removeLine} clear={clearCart}
                notes={notes} setNotes={setNotes}
                setup={setupData}
                suggestions={suggestions}
                onSubmit={() => setReviewStage("review")}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mini cart FAB for stacked layout */}
      <button className="sf-fab" data-show={units > 0}
              onClick={() => { const el = railRef.current; if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" }); }}>
        <SFIcon name="cart" size={15} /> Cart · {units}
      </button>

      <SFQuickView it={quick} qty={quick ? (cart[quick.sku] || 0) : 0} add={add} sub={sub} onClose={() => setQuick(null)} />

      <SFReviewModal
        stage={reviewStage}
        lines={lines} notes={notes} setup={setupData}
        onClose={() => setReviewStage(null)}
        onConfirm={() => setReviewStage("done")}
        onDone={() => { setReviewStage(null); clearCart(); setNotes(""); }}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Layout" />
        <TweakRadio label="Grid columns" value={t.cols} options={[3, 4, 5]} onChange={v => setTweak("cols", v)} />
        <TweakRadio label="Catalog view" value={t.view} options={["Grid", "Compact"]} onChange={v => setTweak("view", v)} />
        <TweakToggle label="Group by category" value={t.grouped} onChange={v => setTweak("grouped", v)} />
        <TweakToggle label="Frequently-ordered row" value={t.featured} onChange={v => setTweak("featured", v)} />
        <TweakSection label="Theme" />
        <TweakRadio label="Accent" value={t.accent} options={["Green", "Teal", "Ivory"]} onChange={v => setTweak("accent", v)} />
        <TweakToggle label="Dark mode" value={t.dark} onChange={v => setTweak("dark", v)} />
        <TweakSection label="States" />
        <TweakToggle label="Loading skeletons" value={t.loading} onChange={v => setTweak("loading", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<StorefrontPage />);
